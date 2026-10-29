// A hidden form field named "website". Real visitors never see it, so never fill it in; a bot that fills every field does. The bot gets a normal-looking
// success answer (so it learns nothing) and nothing is saved.
const { created } = require('../utils/ApiResponse');

function honeypot(req, res, next) {
  const trap = req.body && req.body.website;
  if (typeof trap === 'string' && trap.trim() !== '') return created(res, { id: 'received' }, 'Message received. We will get back to you shortly.');
  if (req.body && 'website' in req.body) delete req.body.website;
  return next();
}

module.exports = honeypot;
