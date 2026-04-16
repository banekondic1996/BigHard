{
  "targets": [
    {
      "target_name": "nw_input_region",
      "sources": [
        "src/x11.cc",
      ],
      "cflags": [ "-std=c++17" ],
      "cflags_cc": [ "-std=c++17" ],
      "libraries": [
        "-lX11",
        "-lXfixes",
        "-lwayland-client"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags_cc": ["-std=c++17"],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS=0" ]
    }
  ]
}
