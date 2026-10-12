# Sandbox Tooling Reference

The EdgeOne Makers Agent Toolkit exposes sandbox execution through `context.sandbox` and `context.tools`.

For Claude Agent SDK, tools are usually registered through `context.tools.toClaudeMcpServer()`.

The relevant MCP tool is `code_interpreter`, usually exposed to Claude as `mcp__edgeone__code_interpreter`.

Arguments:

```json
{
  "language": "python",
  "code": "print(1 + 1)",
  "timeout": 10
}
```

Use Python for deterministic algorithm tasks unless the user asks for another language.

The skill directory and agent `cwd` (including `/tmp/user-code` after deploy) are **not** on this sandbox filesystem. Pass source code in the `code` argument. Do not `import` or `open` host skill paths.
