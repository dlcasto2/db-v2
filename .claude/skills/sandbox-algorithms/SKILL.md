---
name: sandbox-algorithms
description: This skill should be used when the user asks to compute or verify simple algorithmic results such as Fibonacci sequences, factorials, prime numbers, sorting, combinations, permutations, dynamic programming examples, or when the user explicitly asks to run algorithm scripts in the EdgeOne sandbox using code_interpreter or runCode.
---

# Sandbox Algorithms

## Purpose

Execute small deterministic algorithm tasks through the EdgeOne sandbox code interpreter instead of relying only on model reasoning.

## Filesystem (critical)

This skill directory exists only on the Claude Code host (the agent process). It is **not** mounted into the EdgeOne sandbox.

After this skill loads, **do not** list or search the skill base directory.

Never call `files_list`, `files_read`, `files_exists`, or `commands` on:

- this skill's base directory
- `/tmp/user-code`
- `.claude/skills`
- any other agent `cwd` path

Those tools operate on a separate sandbox VM and will return not found.

If you need `scripts/algorithms.py`, use Claude Code `Read` on `.claude/skills/sandbox-algorithms/scripts/algorithms.py`. For typical algorithm questions, skip that file and run a self-contained snippet.

## When to Use

Use this skill for requests involving:

- Fibonacci sequence calculation.
- Factorial calculation.
- Prime or composite number checks.
- Prime list generation.
- Sorting or searching examples.
- Combination, permutation, or binomial coefficient calculation.
- Small dynamic programming demonstrations.
- User requests that explicitly mention sandbox execution, runCode, code_interpreter, or algorithm scripts.

## Workflow

1. Identify the algorithm task and required inputs.
2. Write a small self-contained Python snippet. Do not probe the skill directory first.
3. Execute the snippet with the EdgeOne sandbox `code_interpreter` tool.
4. Inspect `results`, `logs`, and `error`.
5. If execution fails, fix the code and run once more.
6. Return the final answer with a short explanation and the executed result.

## Tool Usage Rules

- Use `code_interpreter` for actual computation whenever available.
- Do not fake tool outputs.
- Do not rely only on mental arithmetic for requested algorithm execution.
- Keep code snippets deterministic and self-contained. Put the full implementation in the `code` argument; do not `import` host skill files.
- Set a reasonable timeout, usually 5 to 15 seconds for small algorithms.
- Avoid network access unless the user explicitly asks for it.
- Avoid writing files unless a file is necessary for the task.

## Output Format

Return:

````md
## Result

...

## Method

- Algorithm: ...
- Executed with: EdgeOne sandbox `code_interpreter`

## Execution Output

```text
...
```
````

For very small answers, keep the response concise.
