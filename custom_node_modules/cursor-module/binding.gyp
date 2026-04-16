{
  "targets": [
    {
      "target_name": "cursor_module",
      "sources": [ "cursor_module.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "libraries": [
        "-lwayland-client"
      ],
      "cflags": [ "-std=c++17" ],
      "cflags_cc": [ "-std=c++17" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}
