import { validate, validators as v } from 'easevalidation';
import pluralize from 'pluralize';
import { Module } from 'oors';
import camelCase from 'lodash/camelCase';
import merge from 'lodash/merge';
import path from 'path';
import { createLoaders } from 'oors-mongodb/build/graphql';

class RADModule extends Module {
  static validateConfig = validate(
    v.isSchema({
      autoCreateLoaders: [v.isDefault(true), v.isBoolean()],
      moduleDefaultConfig: [
        v.isDefault({}),
        v.isSchema({
          autoload: [
            v.isDefault({}),
            v.isSchema({
              services: [v.isDefault(true), v.isBoolean()],
              methods: [v.isDefault(true), v.isBoolean()],
            }),
          ],
        }),
      ],
    }),
  );

  name = 'oors.rad';

  services = {};

  hooks = {
    'oors.graphql.buildContext': ({ context }) => {
      Object.assign(context, {
        getService: this.getService,
        getModule: name => this.manager.get(name),
      });
    },
  };

  async setup({ autoCreateLoaders }) {
    const dependencies = ['oors.autoloader'];
    if (autoCreateLoaders) {
      dependencies.push('oors.graphql', 'oors.mongodb');
    }

    await this.loadDependencies(dependencies);

    await this.runHook('load', this.collectFromModule);

    this.exportProperties(['registerModuleService', 'setService', 'getService', 'getLoadersName']);

    if (autoCreateLoaders) {
      const { loaders } = this.deps['oors.graphql'];
      const { repositories } = this.deps['oors.mongodb'];

      // creating loaders for repositories that have been added already
      Object.keys(repositories).forEach(repositoryName => {
        this.deps['oors.graphql'].addLoaders(
          createLoaders(repositories[repositoryName]),
          this.getLoadersName(repositoryName),
        );
      });

      this.onModule('oors.mongodb', 'repository', ({ repository, key }) => {
        this.deps['oors.graphql'].addLoaders(createLoaders(repository), this.getLoadersName(key));
      });

      this.export({
        getLoaders: repositoryName => loaders[this.getLoadersName(repositoryName)],
      });
    }
  }

  collectFromModule = async module => {
    const config = merge({}, this.getConfig('moduleDefaultConfig'), module.getConfig(this.name));
    const tasks = [];
    const wrapper = this.deps['oors.autoloader'].wrap(module);

    if (config.autoload.services) {
      tasks.push(this.loadModuleServices(wrapper));
    }

    if (config.autoload.methods) {
      tasks.push(this.loadModuleMethods(wrapper));
    }

    if (!tasks.length) {
      return;
    }

    await Promise.all(tasks);
  };

  async loadModuleServices({ module, glob }) {
    const files = await glob('services/*.js', {
      nodir: true,
    });

    files.forEach(file => {
      const Service = require(file).default; // eslint-disable-line global-require, import/no-dynamic-require
      const service = new Service(module);
      if (!service.name) {
        throw new Error(
          `Unable to register a service without a name! "${file}" in "${module.name}" module`,
        );
      }
      this.registerModuleService(module, service);
    });
  }

  // eslint-disable-next-line class-methods-use-this
  async loadModuleMethods({ module, glob }) {
    const files = await glob('methods/*.js', {
      nodir: true,
    });

    files.forEach(file => {
      const method = require(file).default; // eslint-disable-line global-require, import/no-dynamic-require
      const { name } = path.parse(file);

      if (typeof method !== 'function') {
        throw new Error(
          `Unable to register "${name}" method for ${module.name} module! (not a function)`,
        );
      }

      module.export(name, (...args) =>
        method.call(module, { args, module, getService: this.getService }),
      );
    });
  }

  registerModuleService(module, service) {
    this.setService(`${module.name}.${service.name}`, service);
  }

  setService = (key, service) => {
    this.services[key] = Object.assign(service, {
      getService: this.getService,
    });
  };

  getService = key => this.services[key];

  getLoadersName = repositoryName => pluralize(camelCase(repositoryName));
}

export default RADModule;
