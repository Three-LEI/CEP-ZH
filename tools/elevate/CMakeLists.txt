cmake_minimum_required(VERSION 3.20)
project(cepzh_elevate CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(cepzh-elevate WIN32
    src/main.cpp
    res/app.rc
)

target_compile_definitions(cepzh-elevate PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
set_target_properties(cepzh-elevate PROPERTIES
    OUTPUT_NAME "cepzh-elevate"
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
target_link_libraries(cepzh-elevate PRIVATE shell32 advapi32 ole32)

add_custom_command(TARGET cepzh-elevate POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_SOURCE_DIR}/dist"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:cepzh-elevate>"
        "${CMAKE_SOURCE_DIR}/dist/cepzh-elevate.exe"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:cepzh-elevate>"
        "${CMAKE_SOURCE_DIR}/dist/CEP汉化修复工具.exe"
)
