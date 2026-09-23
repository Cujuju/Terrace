param([string[]]$BuildingIds,[string]$Name='overview',[switch]$Low)
Add-Type -AssemblyName System.Drawing
$censusRoot=Split-Path $PSScriptRoot -Parent
$columns=3
$cellWidth=640
$cellHeight=620
$rows=[int][Math]::Ceiling($BuildingIds.Count/$columns)
$bitmap=[System.Drawing.Bitmap]::new($columns*$cellWidth,$rows*$cellHeight)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(29,33,34))
$graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$font=[System.Drawing.Font]::new('Segoe UI',17,[System.Drawing.FontStyle]::Bold)
for($i=0;$i -lt $BuildingIds.Count;$i++) {
    $id=$BuildingIds[$i]
    $x=($i%$columns)*$cellWidth
    $y=[int][Math]::Floor($i/$columns)*$cellHeight
    $folder=Join-Path $censusRoot $id
    if($Low){$folder=Join-Path $folder 'low'}
    $picture=[System.Drawing.Image]::FromFile((Join-Path $folder "$id-45deg.png"))
    $graphics.DrawImage($picture,[System.Drawing.Rectangle]::new($x,$y+42,640,576))
    $graphics.DrawString($id,$font,[System.Drawing.Brushes]::White,[float]($x+12),[float]($y+8))
    $picture.Dispose()
}
$bitmap.Save((Join-Path $PSScriptRoot "$Name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose();$bitmap.Dispose();$font.Dispose()
