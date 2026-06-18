---
name: "skill-official-updater"
description: "At the start of a new session, do a cheap check for new or updated official Anthropic skills (github.com/anthropics/skills) and offer to add or update them in skills_library/. Also use on explicit request (\"check for official skill updates\", \"sync official skills\")."
applyTo: "**/*"
---

# skill-official-updater

# Official Anthropic Skills Updater

Keeps a local copy of Anthropic's official skills
(https://github.com/anthropics/skills, under `skills/`) in sync with this
repo's `skills_library/`, without silently overwriting unrelated or
hand-edited skills.

## State file

`skills_library/.official-skills-state.json` (create if missing):

```json
{
  "repoSha": "<last-synced commit SHA of anthropics/skills>",
  "skills": {
    "pdf": "<commit SHA of skills/pdf/ at last sync>",
    "docx": "<commit SHA of skills/docx/ at last sync>"
  }
}
```

Only skill names listed under `skills` are "managed" by this updater - a
same-named skill in `skills_library/` that ISN'T listed there is assumed to
be a hand-written/customized skill and must never be overwritten without an
explicit user decision.

## 1. Cheap check (every session)

```sh
git ls-remote https://github.com/anthropics/skills.git HEAD
```

Compare the returned SHA to `repoSha` in the state file (treat a missing
file as "no state yet"). If unchanged, say nothing further - this step
should be silent and near-instant.

## 2. When the repo SHA has changed (or no state file yet)

List the current skill directories upstream:

```sh
gh api repos/anthropics/skills/contents/skills --jq '.[].name'
```

For each upstream skill name, compare against `skills_library/`:

- **New** - upstream name not present locally: candidate to add.
- **Managed + changed** - name is in the state file's `skills` map AND
  `git log -1 --format=%H -- skills/<name>` (in a shallow clone, see below)
  differs from the stored SHA: candidate to update.
- **Unmanaged** - a local skill with the same name exists but isn't in the
  state file's `skills` map: skip, and report it as "name collision, not
  touched" so the user is aware but nothing changes automatically.

Summarize candidates for the user (new vs. updated, with each skill's
one-line `description` from its SKILL.md frontmatter) and ask which to
pull. Don't write anything before the user confirms - pulling external code
and adding manifest entries is worth a quick check-in.

## 3. Pulling selected skills

Use a temporary shallow sparse clone so only the needed skill directories are
fetched:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/anthropics/skills.git <tmpdir>
cd <tmpdir> && git sparse-checkout set skills/<name1> skills/<name2> ...
```

For each selected skill, copy `<tmpdir>/skills/<name>/` to
`skills_library/<name>/` (only for "new" or "managed + changed" candidates -
never for an "unmanaged" collision). Delete `<tmpdir>` afterwards.

## 4. Manifest entries

For each newly added skill, add an entry to `skills_library/manifest.json`:

- `description`: the skill's SKILL.md frontmatter `description`, trimmed to
  one line.
- `detect_globs`: pick something reasonable for the skill's purpose -
  file-format skills (`docx`, `pptx`, `xlsx`, `pdf`) should match their
  extension(s) (e.g. `**/*.docx`); general-purpose/creative skills
  (`algorithmic-art`, `brand-guidelines`, `theme-factory`,
  `web-artifacts-builder`, `slack-gif-creator`, `frontend-design`,
  `canvas-design`) can use `**/*` since they're not file-driven. If unsure,
  ask the user rather than guessing.

For updated skills, the manifest entry usually doesn't need to change unless
the description changed meaningfully - update it if so.

## 5. Update state and finish

- Write the new `repoSha` and per-skill SHAs (for every skill added or
  updated) to `skills_library/.official-skills-state.json`.
- If `extension/` exists in this repo, remind the user to run
  `npm run sync-skills` inside it to refresh the bundled copy.
- Remind the user that `py generate_skills.py install` (or the VS Code
  extension's "Install Skill Library to ~/.claude/skills") re-publishes the
  updated library to `~/.claude/skills/`.

## 6. No `git`/`gh` available

If neither `git` nor `gh` is available, say so and stop - don't attempt to
fetch individual files via raw URLs as a substitute, since that won't
reliably capture a skill's full directory (scripts, references, assets).
