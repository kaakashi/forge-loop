# AGENTS

Forge Loop treats AI models as specialized engineering workers.

Agents are intentionally scoped.

No single agent owns the complete workflow.

---

# Planner

Responsibilities

- understand task
- inspect repository
- identify relevant files
- generate execution strategy

Must NOT

- modify files
- run tests
- publish code

---

# Implementer

Responsibilities

- modify repository
- follow implementation plan
- minimize scope

Must NOT

- change unrelated files
- skip constraints
- approve its own work

---

# Validator

Responsibilities

- run deterministic checks

Examples

- tests
- lint
- typecheck
- formatting

Validator never edits code.

---

# Reviewer

Responsibilities

- compare implementation against task
- inspect validation artifacts
- determine whether task is complete

Reviewer should challenge implementation assumptions.

---

# Publisher

Responsibilities

- prepare final output
- commit
- create branch
- generate publish artifacts

Publisher assumes validation and review already succeeded.

---

# Philosophy

Each stage should be independently replaceable.

Better models improve outcomes.

The engineering workflow remains unchanged.
