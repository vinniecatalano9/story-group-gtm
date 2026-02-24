/**
 * Generate common email pattern guesses for a person at a domain.
 * Used as waterfall fallback when Hunter.io doesn't find an email.
 */
function generateEmailPatterns(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return [];
  const f = firstName.toLowerCase();
  const l = lastName.toLowerCase();
  const fi = f[0]; // first initial

  return [
    `${f}.${l}@${domain}`,
    `${f}${l}@${domain}`,
    `${fi}${l}@${domain}`,
    `${fi}.${l}@${domain}`,
    `${f}@${domain}`,
    `${f}_${l}@${domain}`,
  ];
}

module.exports = { generateEmailPatterns };
