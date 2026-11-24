#!/usr/bin/env bash
# Completeness check: no mock, sample or fabricated data in shipped UI.
# Fails on known markers in src/app and src/components. Tests are excluded.
set -uo pipefail

patterns=(
  '\bmock[A-Z_][A-Za-z]*'          # mockData, mockExportData, MOCK_...
  '\bsample(Nodes|Edges|Data|Entities|Results)\b'
  'Mock (usage|data|stats)'
  'for demo'
  'Placeholder implementation'
  '[Ll]orem ipsum'
  'Math\.random\('
  'in a real implementation'
  'TODO'
  'FIXME'
)

status=0
for p in "${patterns[@]}"; do
  hits=$(grep -rnE "$p" src/app src/components --include='*.ts' --include='*.tsx' || true)
  if [ -n "$hits" ]; then
    echo "Found disallowed pattern /$p/:"
    echo "$hits"
    echo
    status=1
  fi
done

if [ $status -eq 0 ]; then
  echo "No mock/sample data markers found in UI code."
fi
exit $status
