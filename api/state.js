export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  const gistId = process.env.GIST_ID
  const token = process.env.GIST_TOKEN || process.env.GITHUB_TOKEN

  if (!gistId || !token) {
    return res.status(500).json({ error: 'Missing GIST_ID or GIST_TOKEN' })
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'plan-de-table',
  }

  try {
    if (req.method === 'GET') {
      const gh = await fetch(`https://api.github.com/gists/${gistId}`, { headers })
      if (!gh.ok) {
        return res.status(gh.status).json({ error: 'gist fetch failed' })
      }
      const gist = await gh.json()
      const raw = gist.files?.['state.json']?.content
      const data = raw ? JSON.parse(raw) : null
      return res.status(200).json(data)
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      JSON.parse(body)
      const gh = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: { 'state.json': { content: body } },
        }),
      })
      if (!gh.ok) {
        const text = await gh.text()
        return res.status(gh.status).json({ error: 'gist update failed', detail: text })
      }
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' })
  }
}
