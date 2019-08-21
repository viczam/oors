import { validate, validators as v } from 'easevalidation';
import { Module } from 'oors';
import { isMiddlewarePivot } from 'oors-express/build/validators';
import { getClientIp } from 'request-ip';
import { createRateLimitDirective } from 'graphql-rate-limit';
import ms from 'ms';
import rateLimitMiddleware from './middlewares/rateLimit';

class RateLimiterModule extends Module {
  static validateConfig = validate(
    v.isSchema({
      middleware: [
        v.isDefault({}),
        v.isSchema({
          isEnabled: [v.isDefault(true), v.isBoolean()],
          pivot: [
            v.isDefault({
              after: 'bodyParserURLEncoded',
            }),
            isMiddlewarePivot(),
          ],
          config: [
            v.isDefault({}),
            v.isSchema({
              max: v.isAny(
                v.isUndefined(),
                v.isEvery(v.isNumber(), v.isMin(0, true)),
                v.isFunction(),
              ),
              windowMs: [v.isDefault(60000), v.isNumber(), v.isMin(0, true)],
              message: v.isAny(v.isUndefined(), v.isString(), v.isObject()),
              statusCode: [v.isDefault(429), v.isNumber()],
              headers: [v.isDefault(true), v.isBoolean()],
              keyGenerator: v.isAny(v.isUndefined(), v.isFunction()),
              handler: v.isAny(v.isUndefined(), v.isFunction()),
              onLimitReached: v.isAny(v.isUndefined(), v.isFunction()),
              skipFailedRequests: [v.isDefault(false), v.isBoolean()],
              skipSuccessfulRequests: [v.isDefault(false), v.isBoolean()],
              skip: [v.isDefault((/* req, res */) => false), v.isFunction()],
              store: v.isAny(v.isUndefined(), v.isObject()),
            }),
          ],
        }),
      ],
    }),
  );

  name = 'oors.rateLimiter';

  services = {};

  async setup() {
    await this.loadDependencies(['oors.express', 'oors.graphql']);

    if (this.getConfig('middleware.isEnabled')) {
      this.deps['oors.express'].middlewares.insert(
        this.getConfig('middleware.pivot'),
        this.createMiddleware({
          params: this.getConfig('middleware.config'),
        }),
      );
    }

    this.exportProperties(['createMiddleware', 'keyGenerator', 'createDirective']);
  }

  createMiddleware = ({ params = {}, ...rest } = {}) => ({
    ...rateLimitMiddleware,
    ...rest,
    params: {
      ...(rateLimitMiddleware.params || {}),
      keyGenerator: this.keyGenerator,
      ...params,
    },
  });

  createDirective = (options = {}) =>
    createRateLimitDirective({
      identifyContext: ctx =>
        (ctx.user && (ctx.user.id || ctx.user._id).toString()) || getClientIp(ctx.request),
      formatError: ({ fieldName, max, window }) =>
        `You've called '${fieldName}' ${max} times in the past ${ms(window, { long: true })}!`,
      ...options,
    });

  keyGenerator = req => (req.user ? (req.user.id || req.user._id).toString() : getClientIp(req));
}

export default RateLimiterModule;