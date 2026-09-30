// Fuzzy ticket search for the top bar.
//
// The query is split on whitespace; every word must match the ticket. A word
// matches when it appears as a substring of the id, title, labels, assignee,
// size or description, or as a fuzzy subsequence of "id title" (so "rdhst"
// finds "Ride history"). Matching ignores case and accents.
//
// scoreTicket returns 0 for no match, otherwise a higher-is-better score:
// title/id hits beat label hits, which beat description hits, and substring
// hits beat subsequence hits.

export function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Score `needle` as an in-order subsequence of `hay`: 0 if it isn't one,
// more when the characters are consecutive or start a word. Letters scattered
// with no word starts or runs ("bio" in "mob offline") score 0 too.
export function fuzzyScore(needle, hay) {
  if (!needle) return 0;
  let score = 0;
  let prev = -2;
  let from = 0;
  for (const ch of needle) {
    const i = hay.indexOf(ch, from);
    if (i === -1) return 0;
    score += 1;
    if (i === prev + 1) score += 2; // consecutive
    if (i === 0 || /[\s\-_/]/.test(hay[i - 1])) score += 3; // word start
    prev = i;
    from = i + 1;
  }
  return score >= needle.length * 2 ? score : 0;
}

export function scoreTicket(ticket, query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const head = normalize(`${ticket.id} ${ticket.title}`);
  const tags = normalize([...(ticket.labels || []), ticket.assignee, ticket.size].join(" "));
  const body = normalize(ticket.body);

  let total = 0;
  for (const w of words) {
    let s = 0;
    if (head.includes(w)) s = 100 + (head.startsWith(w) || head.includes(` ${w}`) ? 20 : 0);
    else if (tags.includes(w)) s = 60;
    else if (body.includes(w)) s = 30;
    else if (w.length >= 2) s = fuzzyScore(w, head);
    if (!s) return 0;
    total += s;
  }
  return total;
}
