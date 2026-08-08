# Task Lifecycle

Every Forge Loop task moves through the same lifecycle.

```
Queued
   │
Planning
   │
Workspace
   │
Implementation
   │
Validation
   │
Review
   │
Publish
```

Possible outcomes:

- Success
- Validation Failed
- Review Failed
- Human Intervention Required

Every stage produces artifacts.

Tasks are intentionally deterministic wherever possible.

The language model is responsible for reasoning, not for determining whether work is accepted.
