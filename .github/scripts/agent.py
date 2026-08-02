import os
import json
import sys
from openai import OpenAI
from github import Github

# 1. Load environment variables
api_key = os.getenv("DEEPSEEK_API_KEY2")
github_token = os.getenv("GITHUB_TOKEN")
event_path = os.getenv("GITHUB_EVENT_PATH")

if not api_key or not github_token or not event_path:
    print("Missing required environment variables")
    sys.exit(1)

# 2. Read the GitHub event data
try:
    with open(event_path, 'r') as f:
        event_data = json.load(f)
except Exception as e:
    print(f"Failed to read event data: {e}")
    sys.exit(1)

comment_body = event_data.get('comment', {}).get('body', '')
issue_number = event_data.get('issue', {}).get('number')
repo_full_name = os.getenv("GITHUB_REPOSITORY")

if not comment_body or not issue_number:
    print("Could not find comment or issue number in event data.")
    sys.exit(1)

# 3. Initialize DeepSeek and GitHub clients
client = OpenAI(
    api_key=api_key,
    base_url="https://api.deepseek.com"
)
github = Github(github_token)
repo = github.get_repo(repo_full_name)

# 4. Fetch the PR diff if this is a Pull Request
code_context = ""
try:
    issue = repo.get_issue(issue_number)
    if issue.pull_request:
        pr = repo.get_pull(issue_number)
        files = pr.get_files()
        diff_content = ""
        for file in files:
            if file.patch:  # This gives us the actual line-by-line changes
                diff_content += f"\n--- File: {file.filename}\n{file.patch}\n"
        
        if diff_content:
            code_context = f"The user is asking about the following code changes in their Pull Request:\n{diff_content}"
        else:
            code_context = "The user did not provide specific code changes in the PR diff, or the diff is too large to fetch."
    else:
        code_context = "This is an issue thread, not a Pull Request, so no code diff is available."
except Exception as e:
    print(f"Could not fetch PR diff: {e}")
    code_context = "Could not fetch the specific code diff for this request."

# 5. Send the combined context to DeepSeek
system_prompt = """You are a senior software engineer and code reviewer. You are helping a user review their Pull Request and make coding decisions. 
Be direct, constructive, and provide actionable feedback. Use markdown code blocks when showing examples."""

user_prompt = f"""The user triggered this action with the comment: '{comment_body}'.

Here is the code context from the Pull Request:
{code_context}

Please respond as a helpful coding assistant and code reviewer."""

try:
    response = client.chat.completions.create(
        model="deepseek-coder", # Specifically optimized for code review!
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        max_tokens=2048
    )
    ai_reply = response.choices[0].message.content
except Exception as e:
    ai_reply = f"Sorry, I encountered an error trying to reach DeepSeek: {e}"

# 6. Post DeepSeek's response back to the GitHub issue/PR comment section
try:
    issue = repo.get_issue(number=issue_number)
    issue.create_comment(ai_reply)
    print(f"Successfully posted reply to issue #{issue_number}")
except Exception as e:
    print(f"Failed to post comment to GitHub: {e}")
