$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$outputPath = Join-Path $PSScriptRoot 'textures\sign-atlas.png'
$bitmap = [System.Drawing.Bitmap]::new(2048, 2048)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$format = [System.Drawing.StringFormat]::new()
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
function Paint-Line([string]$text, [single]$size, [single]$x, [single]$y, [single]$w, [single]$h, [string]$color, [string]$family = 'Georgia') {
    $font = [System.Drawing.Font]::new($family, $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($color))
    $shadow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(100, 54, 36, 20))
    $graphics.DrawString($text, $font, $shadow, [System.Drawing.RectangleF]::new($x+4,$y+6,$w,$h),$format)
    $graphics.DrawString($text, $font, $brush, [System.Drawing.RectangleF]::new($x,$y,$w,$h),$format)
    $font.Dispose(); $brush.Dispose(); $shadow.Dispose()
}
Paint-Line 'FLIPPER &' 238 15 65 2018 280 '#155467'
Paint-Line "SHRIMP'S" 277 15 350 2018 325 '#CF4D2E'
Paint-Line 'PLACE' 223 15 686 2018 263 '#155467'
Paint-Line 'NO' 172 20 1074 984 230 '#513B26' 'Arial Rounded MT Bold'
Paint-Line 'FISHING' 171 20 1310 984 220 '#513B26' 'Arial Rounded MT Bold'
Paint-Line 'WATER' 141 1044 1080 984 205 '#155467' 'Arial Rounded MT Bold'
Paint-Line 'WIGGLERS' 141 1044 1310 984 205 '#155467' 'Arial Rounded MT Bold'
Paint-Line 'WELCOME.' 141 1044 1540 984 205 '#155467' 'Arial Rounded MT Bold'
$bitmap.Save($outputPath,[System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose(); $format.Dispose()
Write-Output $outputPath
