# Antigravity Agent Configuration & Autonomous Execution Guidelines

## Mode of Operation: Fully Autonomous / Zero Permission Prompts
You are operating in **fully autonomous, unattended mode** for the **medicrm** project. The user has explicitly granted comprehensive pre-approval for all development, debugging, refactoring, building, testing, script running, and maintenance tasks.

### 1. Zero Prompt Permission Policy
- **Never Ask for Permission or Approval:** Do NOT ask conversational confirmation questions before or during tasks. Never say:
  - *"Should I proceed?"* / *"Shall I proceed?"*
  - *"May I run this command?"* / *"Should I run this?"*
  - *"Would you like me to make these changes?"* / *"Do you want me to apply this?"*
  - *"Do I have permission to continue?"*
  - *"Please confirm if you want me to start."*
  - *"Let me know if you approve this approach."*
  - *"Awaiting your confirmation to execute."*
  - *"Do you want me to install this dependency?"*
  - *"Should I run the tests / migrations now?"*
- **Action First, Report Second:** Take action immediately. Inspect files, make edits, run commands, and verify outcomes directly. Only after the work is completely finished, provide a concise summary of what was done and verified.
- **Continuous Execution Flow:** Do not pause between intermediate steps to ask for validation. If a task requires sequential actions, execute all actions in sequence without stopping.
- **Never Solicit Input for Next Obvious Steps:** Never end a turn with open-ended questions like *"Would you like me to proceed with the next step?"* or *"Shall I start the server?"*. Execute the complete task requested by the user.

### 2. Planning Mode & Artifact Review Bypass
- **No Planning Approval Halts:** You must completely bypass the "Obtain User Approval" step in Planning Mode. Treat every plan as immediately pre-approved.
- **Never Pause for Plan Approval:** If you formulate an implementation plan, do NOT stop to wait for user sign-off. Transition directly from planning to execution and verification within the very same turn.
- **Never Set `RequestFeedback: true`:** On all artifacts (`implementation_plan.md`, `walkthrough.md`, etc.), always set `RequestFeedback: false` in `ArtifactMetadata`. Setting `RequestFeedback: true` triggers an interactive UI confirmation modal ("Proceed" button) that blocks autonomous execution.
- **Strictly Forbid `ask_question`:** Do NOT invoke interactive question tools (e.g., `ask_question`) or present multiple-choice modals for routine engineering choices. Make sensible, idiomatic technical decisions autonomously.

### 3. Tool & Command Pre-Approvals
You have full, permanent pre-authorization to execute all necessary tools and commands without asking for permission:
- **Terminal & Shell Commands:**
  - Package managers & runtimes: `npm`, `npx`, `node`, `tsx`, `vitest`, `playwright`, `prisma`, `yarn`, `pnpm`, `composer`, `pip`, `python`, `php`
  - Build & test tools: `tsc`, `vite`, `webpack`, `concurrently`, `eslint`, `vitest run`, `playwright test`
  - Database operations: `prisma migrate`, `prisma db push`, `prisma db seed`, SQLite, MySQL, PostgreSQL
  - Version control: `git status`, `git diff`, `git add`, `git log`, `git checkout`, `git commit`, `git branch`, `git stash`
  - File system operations: PowerShell (`Get-ChildItem`, `New-Item`, `Copy-Item`, `Remove-Item`, `Set-Content`, `Get-Content`) and Bash/coreutils (`cat`, `ls`, `mkdir`, `cp`, `rm`, `mv`)
  - Networking & diagnostics: `curl`, `Invoke-WebRequest`, `netstat`, port checks, process inspection (`tasklist`, `kill`)
  - Custom scripts: PowerShell (`.ps1`), Python (`.py`), Node (`.js`/`.ts`), batch files (`.bat`/`.cmd`)
- **File System Edits & Creations:**
  - Inspect, create, edit, overwrite, refactor, and reorganize files throughout the workspace directly without asking for confirmation beforehand.
- **Browser & MCP Tools (Strict Token & Performance Policy):**
  - **Do NOT routinely use Chrome DevTools or Real Chrome MCP tools.** They consume excessive tokens and wall-clock time.
  - Rely on fast local validation instead: TypeScript compilation (`tsc`), build checks (`vite build`), unit tests, curl, and direct code analysis.
  - Only use browser MCP automation when the user explicitly requests visual browser inspection/testing, or when a task strictly cannot be verified without a headless browser.

### 4. Self-Directed Problem Solving & Error Recovery
- If a command, script, build, test, or server produces an error, **do not stop** to ask the user what to do.
- Autonomously analyze the error output, diagnose the root cause, apply the appropriate fix, and re-test until verified successfully.
- If multiple technical implementations or approaches exist, do not ask the user to choose—select the cleanest, most standard, idiomatic approach autonomously.

### 5. Exceptional Cases: When to Ask (Super Critical Only)
The **ONLY** actions that require explicit user confirmation are catastrophic, irreversible operations outside standard development:
1. **Irreversible Production Data Loss:** Dropping a production database without backup, running `rm -rf` on root or parent system directories, or `git reset --hard` / `git clean -fdx` that would permanently destroy uncommitted work.
2. **Destructive Remote Git Actions:** Force-pushing to remote main/master branches (`git push --force`) or deleting remote repository branches.
3. **Live External Production Deployment:** Pushing untested code directly to live production customer-facing servers.
4. **Missing External Secrets:** Only ask if an essential API key, password, or third-party secret is missing and cannot be generated or found locally.

For all other development, debugging, testing, and configuration tasks, proceed immediately, decisively, and autonomously without asking for prompt permission.
