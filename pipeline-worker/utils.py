import io
import logging
import os
import re
import zipfile
from pathlib import Path
from typing import Dict, List
import requests
import yaml

logger = logging.getLogger(__name__)

CONTENT_SERVER_URL = os.environ.get("CONTENT_SERVER_URL", "https://content.bibletranslationtools.org/WA-Catalog")


def extract_file_from_zip(zip_path: Path, filename: str, output_path: Path):
    """Extract a specific file from a zip archive to a target file path."""
    with zipfile.ZipFile(zip_path, 'r') as zip_file:
        file_content = zip_file.read(filename)
        with open(output_path, 'wb') as f:
            f.write(file_content)


def split_alignment_zip_by_prefix(zip_path: Path, output_dir: Path) -> List[Path]:
    """
    Split an alignment zip file into multiple zip files grouped by three-letter prefix.
    The original zip contains files like:
    - visualization/1CH-001.html
    - visualization/EXO-002.html
    
    This function creates separate zip files for each three-letter prefix (e.g., 1CH, EXO).
    """
    os.makedirs(str(output_dir), exist_ok=True)
    
    pattern = re.compile(r'visualization/(\w{3})-\d{3}\.html')    
    prefix_groups: Dict[str, List[tuple]] = {}
    other_files: List[tuple] = []
    
    # Read the original zip and group files by prefix
    with zipfile.ZipFile(zip_path, 'r') as source_zip:
        for file_info in source_zip.infolist():
            filename = file_info.filename
            match = pattern.match(filename)
            
            if match:
                prefix = match.group(1)
                if prefix not in prefix_groups:
                    prefix_groups[prefix] = []

                file_data = source_zip.read(filename)
                prefix_groups[prefix].append((filename, file_info, file_data))
    
    # Create a zip file for each prefix group
    zip_splits: List[Path] = []
    
    for prefix, files in prefix_groups.items():
        zip_filename = output_dir / f"{prefix}.zip"
        
        with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as prefix_zip:
            # Add all files for this prefix
            for filename, file_info, file_data in files:
                prefix_zip.writestr(file_info, file_data)
            
            # Also include non-visualization files (e.g., spell-check files) in each prefix zip
            for filename, file_info, file_data in other_files:
                prefix_zip.writestr(file_info, file_data)
        
        zip_splits.append(zip_filename)
    
    logger.info(f"Split alignment zip into {len(zip_splits)} files by prefix")
    return zip_splits


def fetch_source_for_alignment(repo_path: Path, output_dir: Path, default_branch: str = "master") -> Path | None:
    os.makedirs(str(output_dir), exist_ok=True)
    source = load_source_from_yaml(repo_path / "manifest.yaml")
    if source is None:
        logger.warning(f"No source listed in {repo_path / 'manifest.yaml'}")
        return None
    source_id, source_language, source_version = source
    base_url = f"{CONTENT_SERVER_URL}/{source_language}_{source_id}"
    headers = { 'User-Agent': 'btt-writer-greekroom' }

    response = requests.get(f"{base_url}/archive/v{source_version}.zip", headers=headers)
    # if exists, download the zip file and extract it to the output directory
    if response.status_code == 200:
        with zipfile.ZipFile(io.BytesIO(response.content), 'r') as zip_file:
            zip_file.extractall(output_dir)
            # return the first item in the output directory as repo root
            return next(output_dir.iterdir())
    else:
        # get the default version from WACS instead
        response = requests.get(f"{base_url}/archive/{default_branch}.zip", headers=headers)
        if response.status_code == 200:
            with zipfile.ZipFile(io.BytesIO(response.content), 'r') as zip_file:
                zip_file.extractall(output_dir)
                # return the first item in the output directory as repo root
                return next(output_dir.iterdir())
        else:
            print(f"Failed to fetch source from WACS. Response code: {response.status_code}")

    return None

def load_source_from_yaml(path: str) -> tuple[str, str, str] | None:
        """Return the manifest's first source, or None if it lists none."""
        with open(path, 'r') as f:
            manifest = yaml.safe_load(f)

        sources = (manifest.get('dublin_core') or {}).get('source')
        if not sources:
            return None
        source = sources[0]
        source_id = source['identifier']
        source_language = source['language']
        source_version = source['version']

        return source_id, source_language, source_version