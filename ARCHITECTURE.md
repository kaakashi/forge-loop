# Architecture

Forge Loop separates reasoning from engineering.

```
              User Task
                   │
                   ▼
             Planner Agent
                   │
          Execution Plan
                   │
                   ▼
        Workspace Manager
                   │
          Git Worktree
                   │
                   ▼
         Implementation Agent
                   │
             Source Changes
                   │
                   ▼
         Validation Pipeline
        (Tests / Lint / Build)
                   │
          Validation Report
                   │
                   ▼
            Review Agent
                   │
          Review Decision
                   │
                   ▼
             Publisher
```

## Components

### Planner

Creates an execution strategy.

---

### Workspace

Creates isolated Git worktrees.

---

### Implementation

Produces source modifications.

---

### Validation

Runs deterministic tooling.

Examples:

- npm test
- lint
- build

---

### Review

Independent reasoning pass.

Uses:

- original task
- implementation
- validation artifacts

---

### Publish

Generates final outputs suitable for Git workflows.

## Goals

- reproducibility
- isolation
- observability
- deterministic validation
- model independence
