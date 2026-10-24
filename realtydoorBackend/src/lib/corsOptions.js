// A request from an origin that is not on the list gets no CORS headers (so a browser will not let that page read the answer), and
// is otherwise answered normally. It used to be passed to the error handler, so every preflight from another origin was a 500.
function buildCorsOptions(allowedOrigins) {
  return {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // Postman / curl / mobile
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  };
}

module.exports = { buildCorsOptions };
