import { ZodError } from 'zod';

/**
 * Express middleware factory — validates req.body against a Zod schema.
 * Usage: router.post('/signup', validate(signupSchema), handler)
 */
export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const messages = err.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        console.warn('[validate] Validation failed:', messages, '| body keys:', Object.keys(req.body || {}));
        return res.status(400).json({ error: 'Validation failed', details: messages });
      }
      next(err);
    }
  };
}
