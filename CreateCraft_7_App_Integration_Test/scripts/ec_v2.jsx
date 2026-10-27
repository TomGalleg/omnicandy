var c = app.project.activeItem ? app.project.activeItem : null;
var comp = null;
for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i) instanceof CompItem) { comp = app.project.item(i); break; } }
writeLn("comp " + comp.name + " layers " + comp.numLayers);
var n = 0;
for (var j = 1; j <= comp.numLayers; j++) {
  var L = comp.layer(j);
  if (L.name.indexOf("Light streak") == 0) { L.property("Transform").property("Scale").setValue([100, 260]); n++; }
  if (L.name == "Tagline") { L.property("Transform").property("Position").setValue([960, 860]); }
}
writeLn("streaks thickened " + n);
app.project.save(new File("E:/ClaudeCraft/CreateCraft_7_App_Integration_Test/EffectCraft/volterra-x1-logo-reveal-v2.ecproj"));
