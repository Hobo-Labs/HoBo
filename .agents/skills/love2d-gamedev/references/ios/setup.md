# iOS Build Setup

Complete setup guide for building Love2D games on iOS.

## Prerequisites

- macOS with Xcode installed (16+ recommended)
- Apple Developer Account (free works for personal device testing)
- iOS device connected via USB
- Love2D desktop app for testing

## Step 1: Download Required Files

From https://love2d.org/ or https://github.com/love2d/love/releases:

1. **`love-X.X-ios-source.zip`** - Xcode project and source
2. **`love-X.X-apple-libraries.zip`** - Required iOS libraries

## Step 2: Extract and Setup Libraries

```bash
# Extract both archives
unzip love-11.5-ios-source.zip
unzip love-11.5-apple-libraries.zip

# Copy iOS libraries to correct location
cp -r love-apple-dependencies/iOS/libraries/* \
      love-11.5-ios-source/platform/xcode/ios/libraries/
```

**Verify libraries installed**:
```bash
ls love-11.5-ios-source/platform/xcode/ios/libraries/
# Should see: freetype, lua, openal-soft, etc.
```

## Step 3: Fix Deployment Target

Modern Xcode requires iOS 12.0+ deployment target. Love2D ships with 8.0.

```bash
cd love-11.5-ios-source/platform/xcode

# Update all project files
find . -name "*.pbxproj" -exec sed -i '' \
  's/IPHONEOS_DEPLOYMENT_TARGET = 8.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' {} \;

# Also fix any 12.0 targets if needed
find . -name "*.pbxproj" -exec sed -i '' \
  's/IPHONEOS_DEPLOYMENT_TARGET = 12.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' {} \;
```

**Why 15.0?** Balances broad device compatibility with modern iOS features.

## Step 4: Create game.love

```bash
cd /path/to/your/game

# Bundle all Lua files
zip -9 -r game.love *.lua

# Include assets if you have them
zip -9 -r game.love *.lua assets/ sounds/ images/
```

## Step 5: Add game.love to iOS Project

```bash
cp game.love love-11.5-ios-source/platform/xcode/ios/
```

**Important**: Copying the file is not enough. You must add it to Xcode's bundle resources.

### Method A: Xcode UI (Preferred)

1. Open `love.xcodeproj` in Xcode
2. In project navigator, right-click the **ios** folder
3. Select "Add Files to 'love'..."
4. Navigate to and select `game.love`
5. **Check "Add to targets: love-ios"**
6. Click Add

### Method B: Manual pbxproj Edit

If Xcode UI doesn't work, see [xcode-project.md](xcode-project.md) for manual editing.

## Step 6: Configure Signing

1. Select **love-ios** target (not love-macosx)
2. Go to Signing & Capabilities tab
3. Select your **Team** from dropdown
4. Change **Bundle Identifier** to something unique:
   - Example: `com.yourname.yourgame`
   - Must be globally unique

## Step 7: Build and Deploy

1. Connect iOS device via USB
2. Select your device as run destination (not simulator)
3. Press ⌘R or Product → Run
4. Trust the developer certificate on device if prompted:
   - Settings → General → VPN & Device Management

## Troubleshooting

### "No-game screen"

game.love not bundled. Verify in Xcode:
1. Select love-ios target
2. Build Phases → Copy Bundle Resources
3. Confirm game.love is listed

### Build succeeds but app crashes

Check Console.app on Mac for crash logs. Common causes:
- Missing assets referenced in Lua
- Syntax errors in Lua files
- Library incompatibilities

### "Signing requires a development team"

Select your Apple ID team in Signing & Capabilities.

### Simulator vs Device

The simulator is x86/ARM translated and doesn't perfectly match iOS behavior. Always verify on real hardware before considering the build "done."

## Automation Script

For repeated builds, create a script:

```bash
#!/bin/bash
# build-ios.sh

GAME_DIR="/path/to/your/game"
XCODE_DIR="/path/to/love-11.5-ios-source/platform/xcode"

# Build game.love
cd "$GAME_DIR"
rm -f game.love
zip -9 -r game.love *.lua assets/

# Copy to Xcode project
cp game.love "$XCODE_DIR/ios/"

echo "game.love updated. Open Xcode and build (Cmd+R)"
```

Make it executable: `chmod +x build-ios.sh`
