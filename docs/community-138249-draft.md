# Draft comment for community discussion #138249

Target: https://github.com/orgs/community/discussions/138249
("Issue with Expiration of GitHub Actions Run Data in SLSA Provenances", Actions category,
labels Bug / Actions / In Backlog, 12 upvotes, 4 comments, last activity 2025-01-22.)

Not posted. Owner reviews and posts.

---

This gets worse on 1 October, which is probably worth knowing here since this is the thread the
retention work is tracked in.

Yesterday's changelog: "Starting October 1, 2026, checks, workflow runs, and statuses will be
governed by the same Actions retention setting", where until now they "were retained for 400+ days
regardless of your retention configuration". For public repositories the maximum is 90 days,
"matching the existing limit for artifacts and logs".

So the 410 days in the original post stops being a floor. On a public repo a provenance run ID
becomes unresolvable after three months rather than thirteen, and on a private repo it depends on a
setting most people have never touched.

@Steve-Glass is the backlog item from 2024 affected by this, or does the change alter what you were
looking at?

Separately, I wrote a small archiver for my own repos that commits run, check and status metadata to
an orphan branch nightly: https://github.com/Booyaka101/actions-attic. It does not solve the problem
in this thread, since it cannot make the original run URL resolve. It only means the data still
exists somewhere after GitHub drops it.

---

## Notes for the owner

**Least sure about:**

- The tone of the direct question to @Steve-Glass. He said in Sept 2024 he would report back "in the
  next month or so" and never did. I have not referenced that, because pointing at it reads as a
  dig, and the question stands on its own. If you would rather not tag him at all, cut that
  paragraph; the comment works without it.
- "on a private repo it depends on a setting most people have never touched." The changelog states a
  default of 90 days and that the setting applies at repository, organisation and enterprise level.
  I have not independently confirmed what an untouched private repo resolves to on 1 October, so
  this is the softest claim in the draft. Cutting the second half of that sentence loses nothing.
- Whether to include the last paragraph at all. The thread is about SLSA provenance verification and
  the tool genuinely does not fix that, which is why the paragraph says so outright. That honesty is
  what stops it reading as an advert, but if it still feels like one, the first three paragraphs are
  a good comment on their own.

**Checked:** all three quoted fragments are verbatim from the 2026-08-27 changelog. Discussion
#123969 was closed by GitHub staff in favour of #138249, so this is the right thread. There is no
newer community discussion about the 1 October change yet.

**Deliberately not in the draft:** no headers, no bullet lists, no bold. Real comments in that thread
are two to five sentences of plain prose with the occasional inline link, so this already sits at
the long end. No mention of npm, the Marketplace, MIT or the feature list.
