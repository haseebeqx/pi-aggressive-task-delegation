// Per-delegation review is optional; the whole-item task-list gate is not.
export const reviewGuidance = `Independent review is on by default (review: true). Set review:false only for
low-risk, narrow work the worker has concretely verified, or to avoid redundant nested
reviews. Keep review for risky, security-sensitive or broad changes, uncertain
verification, or explicit user requirements. Skipping review never skips the worker's own
verification. A completion with review skipped is not a PASS or independent approval;
integrate the worker's report and note that limitation. In non-interactive task lists,
the final review of each whole item is mandatory.`;

// The verdict is the first non-empty line, tolerating markdown emphasis and
// trailing punctuation ("**PASS**", "PASS."). Anything else, including
// "PASS with caveats", is not approval.
export function isPass(report) {
  const first = String(report ?? '').trim().split(/\r?\n/, 1)[0];
  return /^[\s#>*_`]*PASS[\s*_`.!:]*$/.test(first);
}
