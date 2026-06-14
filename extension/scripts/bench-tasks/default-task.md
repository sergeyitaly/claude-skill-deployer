Reply with exactly `OK` and do not create, modify, or delete any files.

This minimal prompt isolates **skill-catalog overhead** (cache-creation tokens from loaded skills) vs model work. For a substantive task, use:

```bash
npm run bench:skill-impact -- --task-file scripts/agent-comparison-fixture-complex/TASK.md
```
