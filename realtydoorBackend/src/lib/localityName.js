// "marthahalli" -> "Marthahalli", "hoskote-bagalur road" -> "Hoskote-Bagalur Road". Words already in capitals ("BTM") stay as they are.
function tidyLocality(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => word.split('-').map((part) => (part.length > 1 && part === part.toUpperCase() ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())).join('-'))
    .join(' ');
}

module.exports = { tidyLocality };
