# Minecraft Pack Versions Action

A GitHub Action that creates and maintains a JSON file mapping Minecraft versions to their datapack and resourcepack format numbers. This action automatically fetches Minecraft version data from Mojang's official servers, extracts pack format information from client JAR files, and can optionally create automated pull requests with updates.

## What it does

This action:
1. 📥 Fetches the official Minecraft version manifest from Mojang
2. 🔍 Downloads and analyzes client JAR files for each Minecraft version
3. 📊 Extracts datapack and resourcepack format numbers from `version.json` inside each JAR
4. 💾 Creates/updates a JSON file with version-to-format mappings
5. 🔄 Optionally creates automated commits and pull requests with new data
6. ⚡ Processes multiple versions concurrently for faster execution

## Basic Usage

```yaml
name: Update Minecraft Pack Formats
on:
  schedule:
    - cron: '0 12 * * *'  # Daily at noon
  workflow_dispatch:      # Manual trigger

jobs:
  update-formats:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: meza/action-minecraft-pack-versions@v1
        with:
          output_path: 'minecraft-formats.json'
          commit_enabled: true
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

### `output_path`
- **Description**: Relative path (from repo root) to write the JSON file
- **Default**: `'formats.json'`
- **Required**: No
- **Example**: `'data/minecraft-pack-formats.json'`

The generated JSON structure looks like:
```json
{
  "1.20.4": {
    "datapack": 26,
    "resourcepack": 22
  },
  "1.21": {
    "datapack": 48,
    "resourcepack": 34
  }
}
```

### `concurrency`
- **Description**: Number of parallel downloads to process simultaneously
- **Default**: `'0'` (auto-detect based on system resources)
- **Required**: No
- **Possible values**: 
  - `'0'`: Auto-detect (recommended) - calculates based on CPU cores and available memory
  - `'1'` to `'8'`: Manual concurrency limit
- **Effects**: 
  - Higher values = faster processing but more memory usage
  - Auto-detection considers ~80MB per concurrent job
  - Capped at 8 for safety

### `cutoff_version`
- **Description**: Minimum Minecraft version to include in the JSON file
- **Default**: `'18w47b'`
- **Required**: No
- **Example**: `'1.20.0'`, `'23w31a'`
- **Effects**: Only versions released on or after this version will be processed
- **Note**: Use snapshot IDs (like `18w47b`) or release versions (like `1.20.0`)

### `commit_enabled`
- **Description**: Whether to create a commit and PR when new versions are added
- **Default**: `'false'`
- **Required**: No
- **Possible values**: `'true'`, `'false'`
- **Effects**: When `true`, automatically commits changes and creates/updates a pull request

### `commit_type`
- **Description**: Conventional commit type for automated commits
- **Default**: `'chore'`
- **Required**: No
- **Example**: `'feat'`, `'fix'`, `'chore'`, `'docs'`
- **Effects**: Used in commit message template for conventional commits

### `commit_scope`
- **Description**: Optional scope for conventional commits
- **Default**: `''` (empty)
- **Required**: No
- **Example**: `'pack-format'`, `'minecraft'`, `'data'`
- **Effects**: Adds scope to commit message: `chore(pack-format): ...`

### `commit_template`
- **Description**: Mustache template for commit messages
- **Default**: `'{{type}}{{#scope}}({{scope}}){{/scope}}: update pack-format map for {{versions}}'`
- **Required**: No
- **Template variables**:
  - `{{type}}`: The commit type
  - `{{scope}}`: The commit scope (if provided)
  - `{{versions}}`: Comma-separated list of new versions
- **Example**: `'{{type}}: add Minecraft {{versions}} pack formats'`

### `pr_branch`
- **Description**: Branch name to push changes to
- **Default**: `'bot/pack-format'`
- **Required**: No
- **Example**: `'automated/minecraft-updates'`
- **Effects**: Creates or updates this branch with new commits

### `pr_base`
- **Description**: Target branch for pull requests
- **Default**: `'main'`
- **Required**: No
- **Example**: `'develop'`, `'master'`
- **Effects**: PRs will target this branch

### `auto_merge`
- **Description**: Enable automatic merging of pull requests
- **Default**: `'true'`
- **Required**: No
- **Possible values**: `'true'`, `'false'`
- **Effects**: When `true`, enables auto-merge with squash method on created PRs
- **Note**: Requires repository settings to allow auto-merge

### `github_token`
- **Description**: GitHub token for API access
- **Default**: `'${{ github.token }}'`
- **Required**: No (when `commit_enabled` is `false`)
- **Effects**: Used for creating commits, branches, and pull requests
- **Note**: Must have `contents: write` and `pull-requests: write` permissions

## Outputs

### `path`
- **Description**: Path of the generated JSON file
- **Example**: `'formats.json'`
- **Usage**: Access via `${{ steps.step-id.outputs.path }}`

### `new_versions`
- **Description**: Comma-separated list of new versions added to the JSON file
- **Example**: `'1.21,24w14a,1.21.1'`
- **Usage**: Access via `${{ steps.step-id.outputs.new_versions }}`
- **Note**: Empty if no new versions were found

### `did_update`
- **Description**: Boolean indicating if the JSON file was modified
- **Example**: `'true'` or `'false'`
- **Usage**: Access via `${{ steps.step-id.outputs.did_update }}`

## Advanced Usage Examples

### Custom Configuration
```yaml
- uses: meza/action-minecraft-pack-versions@v1
  with:
    output_path: 'assets/minecraft-pack-formats.json'
    cutoff_version: '1.20.0'
    concurrency: '4'
    commit_enabled: true
    commit_type: 'feat'
    commit_scope: 'minecraft'
    commit_template: '{{type}}({{scope}}): add pack formats for {{versions}}'
    pr_branch: 'auto/minecraft-formats'
    pr_base: 'develop'
    auto_merge: false
    github_token: ${{ secrets.PAT_TOKEN }}
```

### Using Outputs
```yaml
- name: Update pack formats
  id: update-formats
  uses: meza/action-minecraft-pack-versions@v1
  with:
    output_path: 'formats.json'

- name: Process results
  if: steps.update-formats.outputs.did_update == 'true'
  run: |
    echo "Updated file: ${{ steps.update-formats.outputs.path }}"
    echo "New versions: ${{ steps.update-formats.outputs.new_versions }}"
    
- name: Upload artifact
  if: steps.update-formats.outputs.did_update == 'true'
  uses: actions/upload-artifact@v4
  with:
    name: minecraft-formats
    path: ${{ steps.update-formats.outputs.path }}
```

### Matrix Strategy for Multiple Files
```yaml
strategy:
  matrix:
    config:
      - { path: 'latest-formats.json', cutoff: '1.21.0' }
      - { path: 'all-formats.json', cutoff: '18w47b' }
      
steps:
  - uses: meza/action-minecraft-pack-versions@v1
    with:
      output_path: ${{ matrix.config.path }}
      cutoff_version: ${{ matrix.config.cutoff }}
      commit_enabled: false
```

## Technical Details

### Performance Considerations
- **Memory Usage**: Each concurrent job uses approximately 80MB of RAM while processing JAR files
- **Network**: Downloads JAR files from Mojang's CDN (typically 10-50MB per version)
- **Rate Limiting**: Mojang's APIs don't have strict rate limits, but the action includes reasonable defaults
- **Caching**: The action reads existing JSON files to avoid reprocessing known versions

### Data Source
- **Version Manifest**: `https://launchermeta.mojang.com/mc/game/version_manifest.json`
- **JAR Files**: Downloaded from URLs provided in individual version metadata
- **Pack Formats**: Extracted from `version.json` inside each client JAR file

### Error Handling
- Individual version failures don't stop the entire process
- Failed downloads are logged but don't cause the action to fail
- Graceful handling of missing or corrupted JAR files
- Atomic file writes prevent corruption during interruption

## Troubleshooting

### Common Issues

**❌ "Reference version not found"**
```
Error: Reference version `18w47b` not found in the manifest.
```
- **Cause**: Invalid `cutoff_version` parameter
- **Solution**: Use a valid Minecraft version ID from the official manifest

**❌ "Permission denied" during commit**
```
Error: Resource not accessible by integration
```
- **Cause**: Insufficient GitHub token permissions
- **Solution**: Ensure the token has `contents: write` and `pull-requests: write` permissions

**❌ "Out of memory" errors**
```
JavaScript heap out of memory
```
- **Cause**: Too high concurrency for available system resources
- **Solution**: Reduce `concurrency` parameter or use `'0'` for auto-detection

**❌ Auto-merge not working**
```
Auto-merge not enabled on pull request
```
- **Cause**: Repository doesn't allow auto-merge or branch protection rules
- **Solution**: Enable auto-merge in repository settings or set `auto_merge: false`

### Debugging

Enable debug logging:
```yaml
- uses: meza/action-minecraft-pack-versions@v1
  env:
    ACTIONS_STEP_DEBUG: true
```

## Examples in the Wild

This action is useful for:
- 📦 **Mod developers**: Keeping track of pack format changes for compatibility
- 🏗️ **Build tools**: Automating version support in development pipelines  
- 📚 **Documentation**: Maintaining accurate version compatibility matrices
- 🔧 **DevOps**: Automating Minecraft server/pack management workflows

## License

This action is available under the [MIT License](LICENSE).
