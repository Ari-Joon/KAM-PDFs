# Make a realistic PDF with Microsoft Word's own "Save as PDF": body text in Calibri, a Cambria
# heading, bold, italic and coloured words, a justified paragraph, a table, a bulleted list, a
# tabbed line and a superscript. Usage: powershell -File make-word.ps1 <out.pdf>
param([string]$out = "$PSScriptRoot\word.pdf")
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection
  $sel.Font.Name = 'Cambria'; $sel.Font.Size = 20; $sel.Font.Bold = 1; $sel.Font.Color = 0x64381F
  $sel.TypeText('Tenancy Agreement Summary'); $sel.TypeParagraph()
  $sel.Font.Name = 'Calibri'; $sel.Font.Size = 11; $sel.Font.Bold = 0; $sel.Font.Color = 0
  $sel.TypeText('Landlord: '); $sel.Font.Bold = 1; $sel.TypeText('Northwind Lettings Ltd'); $sel.Font.Bold = 0
  $sel.TypeText(' of 14 Harbour Street, Bristol.'); $sel.TypeParagraph()
  $sel.TypeText('Monthly rent: '); $sel.Font.Color = 0x0000C0; $sel.Font.Bold = 1; $sel.TypeText([char]0x00A3 + '1,250.00'); $sel.Font.Color = 0; $sel.Font.Bold = 0
  $sel.TypeText(' payable on the 1st of each month.'); $sel.TypeParagraph()
  $sel.TypeText('The deposit is held in an '); $sel.Font.Italic = 1; $sel.TypeText('approved protection scheme'); $sel.Font.Italic = 0
  $sel.TypeText(' within 30 days.'); $sel.TypeParagraph()
  $sel.ParagraphFormat.Alignment = 3
  $sel.TypeText('This paragraph is fully justified, the way most contracts and reports are set, so that every line but the last stretches from the left margin to the right margin, and the spaces between the words are widened to make it fit exactly.')
  $sel.TypeParagraph()
  $sel.ParagraphFormat.Alignment = 0
  $sel.TypeText("Reference:`tTA-2024-0098`tSigned:`t12 March 2024"); $sel.TypeParagraph()
  $sel.TypeText('Energy rating E'); $sel.Font.Superscript = 1; $sel.TypeText('2'); $sel.Font.Superscript = 0; $sel.TypeText(' applies to this property.'); $sel.TypeParagraph()
  $sel.Range.ListFormat.ApplyBulletDefault()
  $sel.TypeText('Tenant pays council tax and utilities'); $sel.TypeParagraph()
  $sel.TypeText('No pets without written consent'); $sel.TypeParagraph()
  $sel.Range.ListFormat.RemoveNumbers()
  $sel.TypeParagraph()
  $t = $doc.Tables.Add($sel.Range, 3, 3)
  $t.Borders.Enable = 1
  $cells = @(@('Item', 'Quantity', 'Cost'), @('Keys', '3', ([char]0x00A3 + '45.00')), @('Fob', '2', ([char]0x00A3 + '30.00')))
  for ($r = 0; $r -lt 3; $r++) { for ($c = 0; $c -lt 3; $c++) { $t.Cell($r + 1, $c + 1).Range.Text = $cells[$r][$c] } }
  $doc.SaveAs2([ref]$out, [ref]17)
  $doc.Close([ref]0)
  Write-Output "wrote $out"
} finally { $word.Quit() }
