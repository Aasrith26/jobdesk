# jobdesk first run on Windows (ONB-1, ONB-5). Installs only what's missing, each with its official
# installer, then checks everything. Safe to run again.
#   powershell -ExecutionPolicy Bypass -File wrapper\install.ps1            # bun + Python (+ pypdf)
#   powershell -ExecutionPolicy Bypass -File wrapper\install.ps1 -Latex     # also Tectonic
param([switch]$Latex)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
function Has($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
$env:Path = "$HOME\.bun\bin;$HOME\.local\bin;$env:Path"

if (-not (Has bun)) {
  Write-Host "Installing bun (runs jobdesk)..."
  powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex" | Out-Null
}
if (-not (Has python)) {
  if (-not (Has uv)) {
    Write-Host "Installing uv (installs Python for you)..."
    powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex" | Out-Null
  }
  Write-Host "Installing Python..."
  uv python install 3.12 --default | Out-Null
}
python -c "import pypdf" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing pypdf (reads PDF resumes)..."
  python -m pip install --user --quiet pypdf
}
if ($Latex -and -not ((Has tectonic) -or (Has xelatex) -or (Has lualatex))) {
  Write-Host "Installing Tectonic (makes PDFs)..."
  powershell -NoProfile -Command "irm https://drop-ps1.fullyjustified.net | iex"
}
Write-Host ""
bun run wrapper/bin/jobdesk.ts doctor
Write-Host ""
Write-Host "Next: claude --plugin-dir wrapper, then /jobdesk:onboard"
Write-Host "No Claude? bun run wrapper/bin/jobdesk.ts intake <your resume> --to-profile"
