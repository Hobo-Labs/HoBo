# Xcode Project Structure

Understanding project.pbxproj for manual game.love bundling.

## When You Need This

When Xcode's "Add Files" UI doesn't work or you need to automate the process, you'll need to manually edit `love.xcodeproj/project.pbxproj`.

## project.pbxproj Overview

The pbxproj file is a structured text file (OpenStep plist format) containing:

- **PBXBuildFile**: Files that get compiled or copied
- **PBXFileReference**: All files known to the project
- **PBXGroup**: Folder structure in Xcode navigator
- **PBXNativeTarget**: Build targets (love-ios, love-macosx)
- **PBXResourcesBuildPhase**: Files copied to app bundle (this is key!)

## Adding game.love Manually

You need to add entries to **four sections**:

### 1. PBXBuildFile Section

Find `/* Begin PBXBuildFile section */` and add:

```
GAMELOVE000200000000001 /* game.love in Resources */ = {isa = PBXBuildFile; fileRef = GAMELOVE000100000000001 /* game.love */; };
```

This tells Xcode "game.love should be copied as a resource."

### 2. PBXFileReference Section

Find `/* Begin PBXFileReference section */` and add:

```
GAMELOVE000100000000001 /* game.love */ = {isa = PBXFileReference; lastKnownFileType = file; name = game.love; path = ios/game.love; sourceTree = "<group>"; };
```

This defines the file reference—where the file lives and what it is.

### 3. PBXGroup (Resources or iOS folder)

Find the group that represents the `ios` folder. Look for something like:

```
/* ios */ = {
    isa = PBXGroup;
    children = (
        ...existing files...
    );
```

Add your file reference to the children array:

```
children = (
    ...existing files...,
    GAMELOVE000100000000001 /* game.love */,
);
```

### 4. Copy Bundle Resources Build Phase

Find the `/* Copy Bundle Resources */` section for the **love-ios target** (not love-macosx). Look for:

```
/* Copy Bundle Resources */ = {
    isa = PBXResourcesBuildPhase;
    buildActionMask = 2147483647;
    files = (
        ...existing files...
    );
```

Add your build file:

```
files = (
    ...existing files...,
    GAMELOVE000200000000001 /* game.love in Resources */,
);
```

## Important Notes

### ID Format

The IDs (like `GAMELOVE000200000000001`) must be:
- **Unique** across the entire file
- **24 characters** (hexadecimal typically, but any chars work)
- **Consistent** between PBXBuildFile fileRef and PBXFileReference

### Finding the Right Target

There may be multiple "Copy Bundle Resources" sections:
- One for love-ios (iOS target) ✓
- One for love-macosx (macOS target)

Make sure you add to the **love-ios** target's build phase.

To identify which is which, look for nearby comments or trace the target's buildPhases array.

### Trailing Commas

Xcode is forgiving about trailing commas in arrays. Adding a comma after your entry is safe.

## Example: Complete Addition

**Before**:
```
/* Begin PBXBuildFile section */
...existing entries...
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
...existing entries...
/* End PBXFileReference section */
```

**After**:
```
/* Begin PBXBuildFile section */
...existing entries...
GAMELOVE000200000000001 /* game.love in Resources */ = {isa = PBXBuildFile; fileRef = GAMELOVE000100000000001 /* game.love */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
...existing entries...
GAMELOVE000100000000001 /* game.love */ = {isa = PBXFileReference; lastKnownFileType = file; name = game.love; path = ios/game.love; sourceTree = "<group>"; };
/* End PBXFileReference section */
```

## Automation Script

```bash
#!/bin/bash
# add-game-to-xcode.sh
# Run from xcode project directory

PBXPROJ="love.xcodeproj/project.pbxproj"

# Unique IDs for game.love
FILE_REF="GAMELOVE000100000000001"
BUILD_REF="GAMELOVE000200000000001"

# Check if already added
if grep -q "$FILE_REF" "$PBXPROJ"; then
    echo "game.love already in project"
    exit 0
fi

# Backup
cp "$PBXPROJ" "$PBXPROJ.backup"

# Add PBXBuildFile entry
sed -i '' "/\/\* Begin PBXBuildFile section \*\//a\\
$BUILD_REF /* game.love in Resources */ = {isa = PBXBuildFile; fileRef = $FILE_REF /* game.love */; };
" "$PBXPROJ"

# Add PBXFileReference entry
sed -i '' "/\/\* Begin PBXFileReference section \*\//a\\
$FILE_REF /* game.love */ = {isa = PBXFileReference; lastKnownFileType = file; name = game.love; path = ios/game.love; sourceTree = \"<group>\"; };
" "$PBXPROJ"

echo "Added game.love references. Manually add to group and build phase if needed."
```

## Verifying Success

After editing:

1. Open Xcode—if it complains about project format, you made a syntax error
2. Check love-ios target → Build Phases → Copy Bundle Resources
3. game.love should appear in the list
4. Build and verify game loads on device

## Troubleshooting

**Xcode won't open project**: Syntax error in pbxproj. Restore backup and try again.

**game.love in project but not loading**: Added to wrong target or wrong build phase. Verify it's in love-ios's "Copy Bundle Resources."

**Duplicate symbol errors**: You added the same ID twice. Each ID must be unique.
