/**
 * Express 4 does not catch a rejected promise from an async route handler: the request hangs until the client gives up
 * and the error is only logged as an unhandled rejection. The world route test (plan B1.4) found six family routes that
 * hung this way when access was denied. This passes every handler's rejection to the error middleware, for all routes.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Layer = require("express/lib/router/layer");

type Next = (err?: unknown) => void;
const original = Layer.prototype.handle_request;
if (!Layer.prototype.__asyncErrors) {
    Layer.prototype.__asyncErrors = true;
    Layer.prototype.handle_request = function handleRequest(this: { handle: (...a: unknown[]) => unknown }, req: unknown, res: unknown, next: Next) {
        const fn = this.handle;
        if (fn.length > 3) return original.call(this, req, res, next); // an error handler
        try {
            const out = fn(req, res, next) as { catch?: (cb: (e: unknown) => void) => void } | undefined;
            if (out && typeof out.catch === "function") out.catch((err) => next(err ?? new Error("route rejected")));
        } catch (err) {
            next(err);
        }
    };
}

export {};
