---
name: pr-description
description: Draft or rewrite a pull request title and description from the current branch's diff. Use this whenever the user asks to write, generate, improve, polish, or fill in a PR description or PR title, wants help summarizing "what changed" for a pull request or `gh pr create`, or asks what to put in the PR body — even if they don't say "PR description" explicitly (e.g. "write the PR for this branch", "summarize this diff for review", "what should the title be"). Make sure to reach for this any time a pull request is about to be opened or updated and its description needs writing, not just when a description already exists to edit.
---

# PR Description Writer

Write pull request descriptions that let a reviewer understand *why* a change
exists and *what to check* without having to read the full diff first. A good
description is a shortcut for the reviewer, not a transcript of the commits.

## Before writing anything

Ground the description in the actual change, not in what you assume was
intended:

1. **Find the diff.** Determine the base branch (usually the repo's default
   branch) and diff against it — e.g. `git diff <base>...HEAD` and
   `git log <base>..HEAD --oneline`. If the user already gave you a diff or
   a PR number, use that instead of re-deriving it.
2. **Look for a template.** Check for `.github/pull_request_template.md`,
   `.github/PULL_REQUEST_TEMPLATE.md`, `PULL_REQUEST_TEMPLATE.md`, or
   `docs/PULL_REQUEST_TEMPLATE.md`. If one exists, use its section headings
   and structure — populate each section from the diff rather than leaving
   placeholder text, and skip any section that asks for something unrelated
   to the change itself (credentials, internal URLs, etc). If none exists,
   use the default structure below.
3. **Read the actual diff, not just file names.** File names tell you what
   moved; the diff tells you what changed and why it's safe (or risky).
   Skim commit messages too — they often carry intent that the code alone
   doesn't (a bug report reference, a "why now").
4. **Check for linked context.** If the branch name, commit messages, or the
   user's request reference an issue number, mention it (`Fixes #123` /
   `Closes #123` uses GitHub's auto-close syntax — only use `Fixes`/`Closes`
   if the PR genuinely resolves the issue, not just relates to it).

## Writing the title

One line, imperative mood, describes the *change* not the *task* — "Add
retry backoff to the sync worker", not "Fix bug" or "Update files". If the
repo has a visible convention (Conventional Commits prefixes like `feat:`,
`fix:`, ticket-ID prefixes, etc. — check recent merged PR titles or commit
history if unsure), follow it. Otherwise keep it under ~70 characters and
skip a trailing period.

## Default structure (no template found)

```markdown
## Summary
<1-3 bullet points, or a short paragraph for a small change>

## Why
<Only include this section if the motivation isn't obvious from the summary
— a bug being fixed, a constraint being worked around, a decision being
made. Skip it for self-evidently mechanical changes.>

## Test plan
<Bulleted checklist: commands run, tests added, manual verification steps.
Write these as things a reviewer could redo, not just "tested locally".>
```

Adapt the section set to the change — a one-line typo fix doesn't need a
"Why" section, and a pure refactor's test plan might just be "existing test
suite passes, no behavior change." Match the length of the description to
the size of the change: don't pad a three-line diff into a five-paragraph
essay, and don't compress a large multi-file change into two bullets that
hide what actually moved.

## Content principles

- **Describe the change, not the diff mechanics.** "Extract the retry logic
  into a shared helper" beats "Move code from file A to file B and rename
  the function." Reviewers can see the mechanics in the diff; they need the
  narrative.
- **Call out anything a reviewer would want to double-check themselves** —
  a behavior change with no test covering it, a migration that touches
  production data, a dependency bump, a change to a security-sensitive
  path. Don't hide risk to make the PR look cleaner; flag it so the
  reviewer knows where to look closely.
- **Don't editorialize about quality.** Skip "this greatly improves
  performance" or "this is a clean solution" — state what changed and let
  the reviewer judge. Facts over sales pitch.
- **Don't invent a test plan.** If you don't know whether tests were run,
  say what you verified (e.g. "ran the existing suite locally") rather than
  claiming coverage that doesn't exist. If nothing was tested, say so —
  that's useful information for the reviewer, not a gap to paper over.
- **No code comments, model attribution, or meta-commentary about the
  writing process** inside the PR body itself.

## Output

If asked to create or update the PR itself (not just draft text), use
whatever PR tooling is available in the current environment (`gh pr
create`/`gh pr edit`, the GitHub MCP tools, etc.) with the drafted title and
body. If only a draft is requested, or no such tooling is available, present
the title and body as markdown in the response, ready to paste.
