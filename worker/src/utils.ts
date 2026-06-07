async function triggerWorkflow(
  env: Env,
  inputs: Record<string, string>,
  workflowFile = "bot.yml"
) {
  if (!env.GITHUB_REPO) throw new Error('GITHUB_REPO not defined');
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'BaleYouTubeBot/1.0'
    },
    body: JSON.stringify({ ref: 'main', inputs })
  });
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  return true;
}





export { triggerWorkflow };
