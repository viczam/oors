import set from 'lodash/set';
import get from 'lodash/get';
import has from 'lodash/has';
import Ajv from 'ajv';
import ajvKeywords from 'ajv-keywords';
import invariant from 'invariant';
import { MongoClient, ObjectID } from 'mongodb';
import path from 'path';
import glob from 'glob';
import { Module } from 'oors';
import Repository from './libs/Repository';
import * as helpers from './libs/helpers';
import idValidator from './libs/idValidator';
import * as decorators from './decorators';
import MigrationRepository from './repositories/Migration';
import Seeder from './libs/Seeder';
import withLogger from './decorators/withLogger';
import withTimestamps from './decorators/withTimestamps';
import Migration from './libs/Migration';
import Migrator from './libs/Migrator';

class MongoDB extends Module {
  static schema = {
    type: 'object',
    properties: {
      connections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
            },
            database: {
              type: 'string',
            },
            url: {
              type: 'string',
            },
            options: {
              type: 'object',
              default: {},
            },
          },
          required: ['name', 'url'],
        },
        minItems: 1,
      },
      defaultConnection: {
        type: 'string',
      },
      migration: {
        type: 'object',
        properties: {
          isEnabled: {
            type: 'boolean',
            default: false,
          },
          dir: {
            type: 'string',
          },
        },
        default: {},
      },
      logQueries: {
        type: 'boolean',
        default: true,
      },
      addTimestamps: {
        type: 'boolean',
        default: true,
      },
      seeding: {
        type: 'object',
        properties: {
          isEnabled: {
            type: 'boolean',
            default: false,
          },
        },
        default: {},
      },
    },
    required: ['connections'],
  };

  name = 'oors.mongodb';

  connections = {};

  repositories = {};

  hooks = {
    'oors.graphql.buildContext': ({ context }) => {
      const { fromMongo, fromMongoCursor, fromMongoArray, toMongo } = helpers;

      if (context.ajv) {
        context.ajv.addKeyword('isId', idValidator);
      }

      Object.assign(context, {
        fromMongo,
        fromMongoCursor,
        fromMongoArray,
        toMongo,
        getRepository: this.getRepository,
        toOjectId: this.toOjectId,
      });
    },
    shutdown: () => this.closeConnection(),
  };

  initialize({ connections, defaultConnection }) {
    this.defaultConnectionName = defaultConnection || connections[0].name;

    const names = connections.map(({ name }) => name);

    if (!names.includes(this.defaultConnectionName)) {
      throw new Error(
        `Default connection name - "(${
          this.defaultConnectionName
        })" - can't be found through the list of available connections (${names})`,
      );
    }
  }

  async setup({ connections, logQueries, addTimestamps }) {
    await Promise.all(connections.map(this.createConnection));

    this.setupValidator();
    this.setupMigration();
    await this.setupSeeding();

    this.onModule(this.name, 'repository', ({ repository }) => {
      if (logQueries) {
        withLogger()(repository);
      }

      if (addTimestamps) {
        withTimestamps()(repository);
      }
    });

    this.exportProperties([
      'createConnection',
      'closeConnection',
      'getConnection',
      'getConnectionDb',
      'createStore',
      'createRepository',
      'bindRepository',
      'bindRepositories',
      'addRepository',
      'getRepository',
      'migrate',
      'ajv',
      'toOjectId',
      'transaction',
      'backup',
    ]);
  }

  setupValidator() {
    this.ajv = new Ajv({
      allErrors: true,
      verbose: true,
      async: 'es7',
      useDefaults: true,
    });

    ajvKeywords(this.ajv, 'instanceof');

    this.ajv.addKeyword('isId', idValidator);
  }

  setupMigration() {
    if (!this.getConfig('migration.isEnabled')) {
      return;
    }

    const migrationRepository = this.addRepository('Migration', new MigrationRepository());

    this.migrator = new Migrator({
      migrationsDir: this.getConfig('migration.dir'),
      context: {
        app: this.app,
        db: this.getConnectionDb(),
      },
      MigrationRepository: migrationRepository,
      transaction: this.transaction,
      backup: this.backup,
    });
  }

  async setupSeeding() {
    if (!this.getConfig('seeding.isEnabled')) {
      return;
    }

    const seeder = new Seeder();
    const seeds = {};

    await Promise.all([
      this.runHook('configureSeeder', () => {}, {
        seeder,
        getRepository: this.getRepository,
      }),
      this.runHook('loadSeedData', () => {}, {
        seeds,
      }),
    ]);

    if (Object.keys(seeds).length) {
      await this.seed(seeds);
    }

    this.export({
      seeder,
    });

    this.exportProperties(['seed', 'seeds']);
  }

  createRepository = ({ methods = {}, connectionName, ...options }) => {
    const repository = new Repository(options);

    Object.keys(methods).forEach(methodName => {
      repository[methodName] = methods[methodName].bind(repository);
    });

    this.bindRepository(repository, connectionName);

    return repository;
  };

  bindRepositories = (repositories, connectionName) =>
    repositories.map(repository => this.bindRepository(repository, connectionName));

  bindRepository = (repository, connectionName) => {
    invariant(
      repository.collectionName,
      `Missing repository collection name - ${repository.constructor.name}!`,
    );

    Object.assign(repository, {
      collection: !repository.hasCollection()
        ? this.getConnectionDb(connectionName).collection(repository.collectionName)
        : repository.collection,
      ajv: this.ajv,
      validate:
        repository.validate ||
        (repository.schema ? this.ajv.compile(repository.schema) : () => true),
      getRepository: this.getRepository,
    });

    repository.configure({
      getRepository: this.getRepository,
    });

    return repository;
  };

  addRepository = (key, repository, options = {}) => {
    const payload = {
      key,
      repository,
      options,
    };

    this.emit('repository', payload);

    set(
      this.repositories,
      payload.key,
      this.bindRepository(payload.repository, options.connectionName),
    );

    return this.getRepository(payload.key);
  };

  getRepository = key => {
    if (!has(this.repositories, key)) {
      throw new Error(`Unable to find "${key}" repository!`);
    }

    return get(this.repositories, key);
  };

  createConnection = async ({ name, url, options }) => {
    this.connections[name] = await MongoClient.connect(
      url,
      options,
    );
    return this.connections[name];
  };

  getConnectionDb = (name = this.defaultConnectionName) => {
    const connection = this.getConnection(name);
    const { database, url } = this.getConfig('connections').find(
      ({ name: _name }) => _name === name,
    );
    return connection.db(database || url.substr(url.lastIndexOf('/') + 1));
  };

  getConnection = name => {
    if (!name) {
      return this.connections[this.defaultConnectionName];
    }

    if (!this.connections[name]) {
      throw new Error(`Unknown connection name - "${name}"!`);
    }

    return this.connections[name];
  };

  closeConnection = name => this.getConnection(name).close();

  migrate = async () => {
    if (!this.getConfig('migration.isEnabled')) {
      throw new Error('Migrations are not enabled!');
    }

    const migrationsDir = this.getConfig('migration.dir');
    if (!migrationsDir) {
      throw new Error(
        `Missing migrations directory! Please provide a "migrationsDir" configuration 
        directive where your migration files are located.`,
      );
    }

    this.emit('migration:before');

    const db = this.getConnectionDb();

    const migrationFiles = await new Promise((resolve, reject) => {
      glob(path.join(migrationsDir, '*.js'), (err, files) => {
        if (err) {
          reject(err);
        } else {
          resolve(files);
        }
      });
    });

    if (!migrationFiles.length) {
      throw new Error(
        `No migration files have been found in the migrations directory ("${migrationsDir}")!`,
      );
    }

    const lastDbMigration = await this.getRepository('Migration').findOne({
      options: {
        sort: [['timestamp', '-1']],
      },
    });

    const lastDbMigrationTimestamp = lastDbMigration ? lastDbMigration.timestamp : 0;

    return migrationFiles
      .filter(file => helpers.getTimestampFromMigrationFile(file) > lastDbMigrationTimestamp)
      .reduce((promise, file) => {
        const timestamp = helpers.getTimestampFromMigrationFile(file);
        const MigrationClass = require(file).default; // eslint-disable-line import/no-dynamic-require, global-require
        const migration = new MigrationClass(this.app, db);

        return promise.then(() =>
          migration.up().then(() =>
            this.getRepository('Migration').createOne({
              timestamp,
              name: migration.name,
            }),
          ),
        );
      }, Promise.resolve());
  };

  seed = data => this.get('seeder').load(data);

  toOjectId = value => new ObjectID(value);

  transaction = (cb, connectionName) => cb(this.getConnectionDb(connectionName));

  // eslint-disable-next-line
  backup = connectionName => {
    // https://github.com/theycallmeswift/node-mongodb-s3-backup
    // https://dzone.com/articles/auto-backup-mongodb-database-with-nodejs-on-server-1
  };
}

export { MongoDB as default, Repository, helpers, decorators, Migration };
