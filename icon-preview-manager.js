// icon-preview-manager.js
// Handles icon loading from .desktop files and window preview generation

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

class IconPreviewManager {
  constructor() {
    this.iconCache = new Map();
    this.previewCache = new Map();
    this.desktopCache = new Map();
    this.previewDir = '/tmp/labwc-previews';
    
    // Create preview directory
    if (!fs.existsSync(this.previewDir)) {
      fs.mkdirSync(this.previewDir, { recursive: true });
    }
    
    console.log('[IconManager] Initialized');
  }

  /**
   * Get icon for an application
   * Priority: .desktop file → icon theme → fallback
   */
  async getIconForApp(appId, pid) {
    console.log('[IconManager] Getting icon for:', appId, 'pid:', pid);
    
    // Check cache first
    if (this.iconCache.has(appId)) {
      return this.iconCache.get(appId);
    }
    
    let iconPath = null;
    
    // Try to find .desktop file
    const desktopFile = await this.findDesktopFile(appId);
    if (desktopFile) {
      iconPath = await this.getIconFromDesktop(desktopFile);
    }
    
    // If no icon from desktop, try process info
    if (!iconPath && pid) {
      iconPath = await this.getIconFromProcess(pid);
    }
    
    // Try icon theme search
    if (!iconPath) {
      iconPath = await this.searchIconTheme(appId);
    }
    
    // Fallback to generic icon
    if (!iconPath || !fs.existsSync(iconPath)) {
      console.log('[IconManager] Using fallback icon for:', appId);
      iconPath = this.getFallbackIcon(appId);
    }
    
    console.log('[IconManager] Found icon:', iconPath);
    this.iconCache.set(appId, iconPath);
    return iconPath;
  }

  /**
   * Find .desktop file for application
   */
  async findDesktopFile(appId) {
    if (!appId) return null;
    
    // Check cache
    if (this.desktopCache.has(appId)) {
      return this.desktopCache.get(appId);
    }
    
    const possibleNames = [
      `${appId}.desktop`,
      `${appId.toLowerCase()}.desktop`,
      `org.${appId}.desktop`,
      `org.${appId.toLowerCase()}.desktop`,
      `${appId.replace(/-/g, '')}.desktop`,
    ];
    
    const searchPaths = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(process.env.HOME, '.local/share/applications'),
      '/var/lib/flatpak/exports/share/applications',
      path.join(process.env.HOME, '.local/share/flatpak/exports/share/applications'),
    ];
    
    for (const searchPath of searchPaths) {
      if (!fs.existsSync(searchPath)) continue;
      
      for (const name of possibleNames) {
        const filePath = path.join(searchPath, name);
        if (fs.existsSync(filePath)) {
          console.log('[IconManager] Found desktop file:', filePath);
          this.desktopCache.set(appId, filePath);
          return filePath;
        }
      }
    }
    
    // Try fuzzy search in application directories
    for (const searchPath of searchPaths) {
      if (!fs.existsSync(searchPath)) continue;
      
      try {
        const files = fs.readdirSync(searchPath);
        const match = files.find(file => 
          file.toLowerCase().includes(appId.toLowerCase()) && 
          file.endsWith('.desktop')
        );
        
        if (match) {
          const filePath = path.join(searchPath, match);
          console.log('[IconManager] Found desktop file (fuzzy):', filePath);
          this.desktopCache.set(appId, filePath);
          return filePath;
        }
      } catch (e) {
        // Ignore errors
      }
    }
    
    return null;
  }

  /**
   * Extract icon path from .desktop file
   */
  async getIconFromDesktop(desktopPath) {
    try {
      const content = fs.readFileSync(desktopPath, 'utf8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('Icon=')) {
          const iconValue = line.substring(5).trim();
          
          // If it's an absolute path and exists, use it
          if (iconValue.startsWith('/') && fs.existsSync(iconValue)) {
            return iconValue;
          }
          
          // Otherwise search icon theme
          const iconPath = await this.searchIconTheme(iconValue);
          if (iconPath) {
            return iconPath;
          }
        }
      }
    } catch (e) {
      console.error('[IconManager] Error reading desktop file:', e);
    }
    
    return null;
  }

  /**
   * Get icon from running process information
   */
  async getIconFromProcess(pid) {
    try {
      // Try to get executable path
      const exePath = fs.readlinkSync(`/proc/${pid}/exe`);
      const exeName = path.basename(exePath);
      
      console.log('[IconManager] Process executable:', exeName);
      
      // Search for icon based on executable name
      return await this.searchIconTheme(exeName);
    } catch (e) {
      console.error('[IconManager] Error reading process info:', e);
      return null;
    }
  }

  /**
   * Search for icon in system icon themes
   */
  async searchIconTheme(iconName) {
    if (!iconName) return null;
    
    const sizes = ['scalable', '48x48', '64x64', '128x128', '256x256', '32x32', '24x24', '16x16'];
    const contexts = ['apps', 'places', 'devices', 'mimetypes'];
    const extensions = ['.png', '.svg', '.xpm'];
    
    const themePaths = [
      '/usr/share/icons/hicolor',
      '/usr/share/icons/Adwaita',
      '/usr/share/pixmaps',
      path.join(process.env.HOME, '.local/share/icons/hicolor'),
      path.join(process.env.HOME, '.icons/hicolor'),
    ];
    
    // Try different combinations
    for (const themePath of themePaths) {
      if (!fs.existsSync(themePath)) continue;
      
      for (const size of sizes) {
        for (const context of contexts) {
          for (const ext of extensions) {
            const iconPath = path.join(themePath, size, context, iconName + ext);
            if (fs.existsSync(iconPath)) {
              console.log('[IconManager] Found theme icon:', iconPath);
              return iconPath;
            }
          }
        }
      }
    }
    
    // Try pixmaps directly
    for (const ext of extensions) {
      const pixmapPath = path.join('/usr/share/pixmaps', iconName + ext);
      if (fs.existsSync(pixmapPath)) {
        return pixmapPath;
      }
    }
    
    return null;
  }

  /**
   * Get fallback icon based on app type
   */
  getFallbackIcon(appId) {
    const lowerAppId = (appId || '').toLowerCase();
    
    // Category-based fallbacks
    if (lowerAppId.includes('terminal') || lowerAppId.includes('console')) {
      return '/usr/share/icons/hicolor/48x48/apps/utilities-terminal.png';
    }
    if (lowerAppId.includes('editor') || lowerAppId.includes('text')) {
      return '/usr/share/icons/hicolor/48x48/apps/accessories-text-editor.png';
    }
    if (lowerAppId.includes('file') || lowerAppId.includes('folder')) {
      return '/usr/share/icons/hicolor/48x48/apps/system-file-manager.png';
    }
    if (lowerAppId.includes('browser') || lowerAppId.includes('web')) {
      return '/usr/share/icons/hicolor/48x48/apps/web-browser.png';
    }
    
    // Generic fallback
    return '/usr/share/icons/hicolor/48x48/apps/application-x-executable.png';
  }

  /**
   * Generate window preview (screenshot)
   */
  async generatePreview(windowId, windowInfo) {
    console.log('[IconManager] Generating preview for window:', windowId);
    
    const previewPath = path.join(this.previewDir, `${windowId}.png`);
    
    try {
      // Use grim to capture window screenshot (for wlroots compositors)
      // We need to get window geometry first
      const { x, y, width, height } = windowInfo;
      
      if (width && height && x !== undefined && y !== undefined) {
        // Calculate window region
        const region = `${x},${y} ${width}x${height}`;
        
        // Take screenshot with grim
        await this.executeCommand(
          `grim -g "${region}" "${previewPath}"`,
          5000
        );
        
        // If successful, resize for thumbnail
        if (fs.existsSync(previewPath)) {
          await this.executeCommand(
            `convert "${previewPath}" -resize 320x180 "${previewPath}"`,
            3000
          );
          
          console.log('[IconManager] Preview generated:', previewPath);
          this.previewCache.set(windowId, previewPath);
          return previewPath;
        }
      }
      
      // Fallback: try using wf-recorder or scrot
      console.log('[IconManager] grim failed, trying alternative methods...');
      return await this.generatePreviewFallback(windowId, windowInfo);
      
    } catch (e) {
      console.error('[IconManager] Error generating preview:', e);
      return null;
    }
  }

  /**
   * Fallback preview generation using alternative methods
   */
  async generatePreviewFallback(windowId, windowInfo) {
    const previewPath = path.join(this.previewDir, `${windowId}.png`);
    
    try {
      // Try using ImageMagick to capture screen region
      const { x, y, width, height } = windowInfo;
      
      if (width && height) {
        await this.executeCommand(
          `import -window root -crop ${width}x${height}+${x}+${y} "${previewPath}"`,
          5000
        );
        
        if (fs.existsSync(previewPath)) {
          await this.executeCommand(
            `convert "${previewPath}" -resize 320x180 "${previewPath}"`,
            3000
          );
          
          this.previewCache.set(windowId, previewPath);
          return previewPath;
        }
      }
    } catch (e) {
      console.error('[IconManager] Fallback preview failed:', e);
    }
    
    return null;
  }

  /**
   * Execute command with timeout
   */
  executeCommand(command, timeout = 5000) {
    return new Promise((resolve, reject) => {
      exec(command, { timeout }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Get cached preview or generate new one
   */
  async getPreview(windowId, windowInfo) {
    // Check cache first
    if (this.previewCache.has(windowId)) {
      const cachedPath = this.previewCache.get(windowId);
      if (fs.existsSync(cachedPath)) {
        return cachedPath;
      }
    }
    
    // Generate new preview
    return await this.generatePreview(windowId, windowInfo);
  }

  /**
   * Clear preview cache for a window
   */
  clearPreview(windowId) {
    const previewPath = this.previewCache.get(windowId);
    if (previewPath && fs.existsSync(previewPath)) {
      try {
        fs.unlinkSync(previewPath);
      } catch (e) {
        console.error('[IconManager] Error deleting preview:', e);
      }
    }
    this.previewCache.delete(windowId);
  }

  /**
   * Clear all caches
   */
  clearAllCaches() {
    this.iconCache.clear();
    this.desktopCache.clear();
    
    // Clear preview files
    if (fs.existsSync(this.previewDir)) {
      try {
        const files = fs.readdirSync(this.previewDir);
        files.forEach(file => {
          fs.unlinkSync(path.join(this.previewDir, file));
        });
      } catch (e) {
        console.error('[IconManager] Error clearing preview cache:', e);
      }
    }
    
    this.previewCache.clear();
  }
}

module.exports = IconPreviewManager;