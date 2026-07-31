/**
 * Branding overrides applied to every text response coming from the origin.
 * Names, the community link and the logo are swapped for the mirror's own.
 */

const TELEGRAM_FROM = /https?:\/\/(?:www\.)?t\.me\/[\w+/-]+/gi;
const TELEGRAM_TO = "https://t.me/official_marco_22";

const LOGO_FROM =
  /https?:\/\/encrypted-tbn0\.gstatic\.com\/images\?q=tbn:ANd9GcT1fXfQMfsh9IK27z-hikKlLU2h8R_A9XUaLg(?:&amp;|&)?s?/gi;
const LOGO_TO = "https://i.ibb.co/PZThbjmf/1000002876-removebg-preview-2.png";

/** "Ratna Bhai" / "RatnaBhai" / "Ratna bhaiya" -> "Mr. Marco" */
const PERSON_FROM = /ratna[\s._-]*bhai(?:ya)?/gi;
const PERSON_TO = "Mr. Marco";

/**
 * "StudyRatna" / "Study Ratna" / "Ratna" -> "pwmarco.live".
 * Hostnames such as `s2-cdn.studyratna.cc` must stay intact, so any match that
 * sits inside a URL-ish token (preceded by `/`, `.`, `-` or followed by `.cc`)
 * is skipped.
 */
const BRAND_FROM = /(^|[^\w./-])(study[\s._-]*ratna|ratna)(?![\w-])(?!\.[a-z]{2,})/gi;
const BRAND_DOMAIN_FROM = /(^|[^\w./-])study[\s_-]*ratna\.cc\b/gi;
const BRAND_TO = "pwmarco.live";

export function rebrand(text: string): string {
  return text
    .replace(TELEGRAM_FROM, TELEGRAM_TO)
    .replace(LOGO_FROM, LOGO_TO)
    .replace(PERSON_FROM, PERSON_TO)
    .replace(BRAND_DOMAIN_FROM, (_m, pre: string) => `${pre}${BRAND_TO}`)
    .replace(BRAND_FROM, (_m, pre: string) => `${pre}${BRAND_TO}`);
}

/** Content types whose bodies are safe to rewrite. */
export function isRebrandable(contentType: string): boolean {
  return /text\/html|text\/css|application\/json|javascript/i.test(contentType);
}
