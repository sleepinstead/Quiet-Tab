"""Create the store upload from the unpacked extension, with stable metadata."""
from pathlib import Path
import json
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / "ext"
manifest = json.loads((source / "manifest.json").read_text())
output = root / "dist" / f"quiet-tab-v{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
    archive = Path(temporary) / output.name
    with zipfile.ZipFile(archive, "w") as package:
        for path in sorted(source.rglob("*")):
            name = path.relative_to(source)
            if any(part.startswith(".") for part in name.parts) or not path.is_file():
                continue
            if path.is_symlink():
                raise ValueError(f"Unexpected symlink: {name}")
            entry = zipfile.ZipInfo(name.as_posix())
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, path.read_bytes(), zipfile.ZIP_DEFLATED)
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
        assert manifest["chrome_url_overrides"]["newtab"] in package.namelist()
        assert set(manifest["icons"].values()).issubset(package.namelist())
    archive.replace(output)
print(output)
