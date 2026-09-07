import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PAGE_SIZES, paginate } from "./pagination.js";

test("pagination covers every paper exactly once and clamps after results shrink", () => {
  assert.deepEqual(DEFAULT_PAGE_SIZES, {
    max_pagesize_main: 30,
    max_pagesize_dropdown: 15,
  });
  for (const size of [15, 30]) {
    for (const count of [0, 1, size, size + 1, 61]) {
      const rows = Array.from({ length: count }, (_, i) => i);
      const pages = paginate(rows, 1, size).pages;
      const collected = Array.from({ length: pages }, (_, i) => {
        const page = paginate(rows, i + 1, size);
        assert.ok(page.items.length <= size);
        return page.items;
      }).flat();
      assert.deepEqual(collected, rows);
      assert.equal(paginate(rows, 99, size).page, pages);
      assert.equal(paginate(rows, -1, size).page, 1);
    }
  }
  assert.equal(paginate([1], NaN, 30).page, 1);
  for (const size of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() => paginate([], 1, size));
});
