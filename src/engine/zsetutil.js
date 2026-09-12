'use strict';

/** Compare two [member, score] pairs the way Redis orders sorted sets:
 *  score ascending, then member lexicographically ascending (byte-wise). */
function comparePairs(a, b) {
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  const am = Buffer.from(String(a[0]), 'utf8');
  const bm = Buffer.from(String(b[0]), 'utf8');
  return Buffer.compare(am, bm);
}

module.exports = { comparePairs };
