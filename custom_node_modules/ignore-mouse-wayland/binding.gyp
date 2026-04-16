{
  "targets": [
    {
      "target_name": "ignore_mouse_wayland",
      "sources": ["ignore_mouse_wayland.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "libraries": ["-lX11", "-lXext","-linput","-ludev"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}
