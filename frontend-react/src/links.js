/**
 * Every external URL the site points at, in one place.
 *
 * App.jsx used to hold these privately, which was fine until a second page needed
 * the same repo URL and had to either duplicate the string or import from App and
 * create a cycle. A six line module is cheaper than either.
 */
export const LINKS = {
  repo: 'https://github.com/AngelofDea1/Firm-Quote',
  x: 'https://x.com/FirmQuoteHQ',

  /** How to underwrite here with a model you wrote yourself. */
  buildAModel: 'https://github.com/AngelofDea1/Firm-Quote/blob/main/BUILD-A-MODEL.md',
};
