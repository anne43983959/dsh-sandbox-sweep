$ErrorActionPreference='Continue'
$dir='C:\Users\High4\AppData\Roaming\in.dsh-plug.dsh-launcher\plugins\dsh-sandbox-sweep'; Set-Location $dir
git add -A 2>&1 | Out-Null
$st = @(git status --short); Write-Host ('changes: ' + $st.Count); $st | Select-Object -First 12 | ForEach-Object { Write-Host ('  ' + $_) }
if ($st.Count -gt 0) {
  git commit -q -m 'temp 溢出与硬杀遗留两处兜底：启动清扫三类来源、temp 根纳入清理、空壳回收（PROBE_VERSION 4）' 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
  $tok=(gh auth token).Trim(); $repo='anne43983959/dsh-sandbox-sweep'
  git remote set-url origin ('https://x-access-token:' + $tok + '@github.com/' + $repo + '.git')
  $env:GIT_TERMINAL_PROMPT='0'
  $o = (git -c credential.helper= push origin main 2>&1 | Out-String)
  Write-Host ($o.Replace($tok,'***').Trim())
  git remote set-url origin ('https://github.com/' + $repo + '.git')
}
Write-Host ('local HEAD = ' + ((git rev-parse HEAD | Out-String).Trim()))
Write-Host ('cloud HEAD = ' + (((gh api repos/anne43983959/dsh-sandbox-sweep/commits --jq '.[0].sha' 2>&1) -join ' ').Trim()))