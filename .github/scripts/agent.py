import os
import json
import sys
import time
import re
from openai import OpenAI
from github import Github

# ==========================
# 1. LOAD ENVIRONMENT VARIABLES
# ==========================
api_key = os.getenv("DEEPSEEK_API_KEY2")
github_token = os.getenv("GITHUB_TOKEN")
org_access_token = os.getenv("ORG_ACCESS_TOKEN")
event_path = os.getenv("GITHUB_EVENT_PATH")

if not api_key or not github_token or not org_access_token or not event_path:
    print("ERROR: Missing environment variables.")
    sys.exit(1)

# ==========================
# 2. READ GITHUB EVENT DATA
# ==========================
try:
    with open(event_path, 'r') as f:
        event_data = json.load(f)
except Exception as e:
    print(f"ERROR: Failed to read event data: {e}")
    sys.exit(1)

comment_body = event_data.get('comment', {}).get('body', '')
issue_number = event_data.get('issue', {}).get('number')
repo_full_name = os.getenv("GITHUB_REPOSITORY")

if not comment_body or not issue_number:
    print("ERROR: Could not find comment or issue number.")
    sys.exit(1)

# ==========================
# 3. INITIALIZE CLIENTS
# ==========================
client = OpenAI(
    api_key=api_key,
    base_url="https://api.deepseek.com"
)

# Use ORG_ACCESS_TOKEN to scan all repos in the org
github_org = Github(org_access_token)
# Use GITHUB_TOKEN to post comments back to the current repo
github_repo = Github(github_token)

repo = github_repo.get_repo(repo_full_name)
owner_name = repo_full_name.split('/')[0]

# ==========================
# 4. FETCH ECOSYSTEM CONTEXT
# ==========================
CORE_REPOS = ['businessblueprint', 'swipesblue', 'hostsblue', 'scansblue', 'builderblue2']
SUPPORT_REPOS = ['tbsys', 'linksblue', 'ai-archive']
TARGET_REPOS = CORE_REPOS + SUPPORT_REPOS

def fetch_ecosystem_context(org_name, target_repo_names):
    context = f"Ecosystem Analysis Target Repos: {', '.join(target_repo_names)}\n\n"
    try:
        org = github_org.get_organization(org_name)
        all_repos = {r.name: r for r in org.get_repos(type='all')}
        
        for repo_name in target_repo_names:
            r = all_repos.get(repo_name)
            if not r:
                context += f"\n--- Repo: {repo_name} (NOT FOUND OR MISSING PERMISSIONS) ---"
                continue
                
            context += f"\n--- Repo: {r.name} ---"
            try:
                contents = r.get_contents("")
                file_list = [f.path for f in contents]
                context += f"\nFiles: {', '.join(file_list)}"
                
                for key_file in ['README.md', 'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'docker-compose.yml', '.env.example']:
                    try:
                        f_content = r.get_contents(key_file)
                        if f_content.size < 30000:
                            content_text = f_content.decoded_content.decode('utf-8', errors='ignore')
                            context += f"\n\n[{key_file} snippet]\n{content_text[:1500]}..." 
                    except:
                        pass
            except Exception as e:
                context += f"\nError scanning repo: {e}"
            time.sleep(1.0)
        context += f"\n\n--- End of targeted ecosystem scan ---"
    except Exception as e:
        context = f"ERROR: Could not fetch ecosystem context. Ensure ORG_ACCESS_TOKEN has 'repo' scope. Error: {e}"
    return context

ecosystem_context = fetch_ecosystem_context(owner_name, TARGET_REPOS)

# ==========================
# 5. FETCH PR DIFF
# ==========================
pr_diff = ""
pr = None
try:
    issue = repo.get_issue(issue_number)
    if issue.pull_request:
        pr = repo.get_pull(issue_number)
        files = pr.get_files()
        diff_content = ""
        for file in files:
            if file.patch:
                diff_content += f"\n--- File: {file.filename}\n{file.patch}\n"
        pr_diff = diff_content if diff_content else "No visible code changes in this PR."
    else:
        pr_diff = "This is an issue thread, not a Pull Request, so no code diff is available."
except Exception as e:
    pr_diff = f"Could not fetch PR diff: {e}"
    pr = None

# ==========================
# 6. SEND PROMPT TO DEEPSEEK (UPDATED FOR QUALITY & FUNCTIONALITY)
# ==========================
system_prompt = """You are a senior software architect at TriadBlue.
Core Apps: businessblueprint, swipesblue, hostsblue, scansblue, builderblue2.
Supporting Infra: tbsys (triadblue.systems), linksblue, ai-archive.

YOUR PRIMARY GOAL IS FUNCTIONAL INTEGRITY & COMPLETENESS:
1. Deeply analyze the PR diff to ensure the code does exactly what it claims to do.
2. STRICTLY FLAG any 'placeholders', 'TODO', 'FIXME', 'pass', 'raise NotImplementedError', or stubbed-out logic left in the code.
3. Ensure data types, error handling, and logical flow are correct and complete.
4. Review how this change impacts the 5 Core apps and 3 Supporting infra repos.

You MUST output ONLY a raw JSON object (no markdown). The JSON MUST have these 3 keys:
1. "inline_comments": A list of objects with {"path": str, "line": int, "body": str}. Only for files changed in THIS PR. (Point out specific placeholders or logic gaps here).
2. "ecosystem_implications": A string summarizing how this PR affects the 5 Core Apps (e.g., breaking changes, security, performance, deployment order).
3. "supporting_repo_changes": A list of objects with {"repo": str, "action": str} detailing specific code/config/dependency changes required in the 3 Supporting Infra repos to accommodate this PR."""

user_prompt = f"""
USER COMMENT: '{comment_body}'

PR CODE DIFF (Current Repo):
{pr_diff}

ECOSYSTEM CONTEXT (Targeted Repos):
{ecosystem_context}

Do a strict functional audit. Flag all TODOs, FIXMEs, or placeholder logic. Return only the JSON object.
"""

try:
    response = client.chat.completions.create(
        model="deepseek-coder",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        max_tokens=4096,
        temperature=0.2
    )
    ai_text = response.choices[0].message.content.strip()
    
    # ROBUST JSON PARSING: Use regex to extract JSON safely
    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', ai_text)
    if json_match:
        ai_text = json_match.group(1)
    
    review_data = json.loads(ai_text)
except Exception as e:
    review_data = {
        "inline_comments": [],
        "ecosystem_implications": f"DeepSeek API parsing error: {e}",
        "supporting_repo_changes": []
    }

# ==========================
# 7. POST RESULTS TO GITHUB
# ==========================
def post_review(data, pr_obj):
    if not pr_obj:
        summary = f"**Ecosystem Implications:**\n{data.get('ecosystem_implications', 'N/A')}\n\n"
        if data.get('supporting_repo_changes'):
            summary += "**Supporting Repo Changes:**\n"
            for item in data['supporting_repo_changes']:
                summary += f"- `{item.get('repo')}`: {item.get('action')}\n"
        issue = repo.get_issue(issue_number)
        issue.create_comment(summary)
        return

    inline_list = data.get('inline_comments', [])
    try:
        for ic in inline_list:
            if ic.get("path") and ic.get("line", 0) > 0:
                pr_obj.create_review_comment(
                    commit_id=pr_obj.head.sha,
                    path=ic["path"],
                    body=ic["body"],
                    line=ic["line"],
                    subject_type="line"
                )
                time.sleep(0.5)
    except Exception as e:
        pass

    summary_body = "## 🧠 Ecosystem Audit & Review Summary\n\n"
    summary_body += "### Impact & Functionality Audit on 5 Core Apps:\n"
    summary_body += f"{data.get('ecosystem_implications', 'No specific implications flagged.')}\n\n"

    changes = data.get('supporting_repo_changes', [])
    if changes:
        summary_body += "### ✅ Required Changes in Supporting Infrastructure:\n"
        for item in changes:
            repo_name = item.get('repo', 'Unknown Repo')
            action = item.get('action', 'No action specified.')
            summary_body += f"- **{repo_name}**: {action}\n"
    else:
        summary_body += "### ✅ Supporting Infrastructure:\nNo changes required in support repos.\n"

    try:
        pr_obj.create_issue_comment(summary_body)
    except Exception as e:
        issue = pr_obj.issue
        issue.create_comment(summary_body)

# EXECUTE
post_review(review_data, pr)