/* Run in the browser console on an IEEE CVPR edition after clicking Load All.
 * Save the returned JSON as an element of the --ieee-snapshots JSON array.
 * Uses only rendered proceedings DOM; no private APIs or catalog writes.
 */
function extractIeeeProceedings(author, initialCandidates = []) {
  const edition = location.pathname.match(/^\/csdl\/proceedings\/cvpr\/(\d{4})\/[^/]+$/);
  if (!edition) throw new Error('Open an IEEE CVPR edition first');
  if ([...document.querySelectorAll('a')].some(a => a.textContent.trim() === 'Load All')) {
    throw new Error('Click Load All and wait for the full list before extracting');
  }
  const records = [...document.querySelectorAll('a.article-title')].map(a => ({
    title: a.textContent.trim(), official_url: a.href,
    authors: [...a.parentElement.querySelectorAll('.article-authors a')].map(n => n.textContent.trim()),
    pages: a.parentElement.querySelector('.badge-pages')?.textContent.trim().replace(/^pp\.\s*/, '')
  }));
  if (!records.length) throw new Error('No loaded article list');
  const count = document.body.innerText.match(/Showing\s+(\d+)\s+out of\s+(\d+)/);
  if (!count || Number(count[1]) !== Number(count[2]) || Number(count[2]) !== records.length) {
    throw new Error('Rendered list count does not confirm complete coverage');
  }
  return JSON.stringify({url: location.href, year: Number(edition[1]), author,
    captured_at: new Date().toISOString(), indexed_papers: records.length,
    complete_list: true, author_order_verified: false,
    records: records.filter(p => p.authors.includes(author)),
    initial_candidates: records.filter(p => p.authors.some(name => initialCandidates.includes(name)))}, null, 2);
}

extractIeeeProceedings("Dahua Lin", ["D. Lin"]);
