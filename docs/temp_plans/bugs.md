# Instructions

1. Read all bugs first, if there are any which relates we can combine and do them.
2. When a bug is complete, tell how to verify it and ask user to verify and and update the bug list. remove fixed bugs. 
3. Ask to continue with the next/current bug after a bug is completed or at the end of a discussion done towards a bug. 
4. If the next bug is not relevant and don't need the context ask to use a new chat. 
5. In a bug discussion if the chat is getting long and unwanted context and can be summarised use the BugFormatSummary example below to write a summary and ask the user to start a new chat. 
4. Project related docs are in /Users/eshandias/Projects/Personal/live-test-runner/docs. temp_plans subfolder has any current developments we are working on
5. Keep reasoning minimal. Provide only essential explanation.

# Bugs



# Bug Summary Format - Example below
### PROJECT SNAPSHOT
Project: Flatshare platform (Rightmove-like)
Stack: Vue 3 (Quasar), Node.js, GraphQL, PostgreSQL
Key modules: auth, listings, chat

### FEATURE / TASK
Fix login/session flow after OAuth2 redirect

### CURRENT STATE
Backend:
- OAuth callback works
- JWT issued correctly

Frontend:
- Redirect loop after login
- Token not persisted correctly

### LAST DECISION POINT
Tried:
- storing token in localStorage → inconsistent
- using Apollo auth link → still fails

### CONSTRAINTS
Must support multi-role users (tenant/agent/landlord)
Must not break existing GraphQL auth middleware

### WHAT I WANT FROM YOU
Identify likely root cause and propose fix steps only