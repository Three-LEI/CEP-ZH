cmake_minimum_required(VERSION 3.21)
cmake_policy(SET CMP0091 NEW)

project(CepZhInstaller LANGUAGES C CXX RC)

# Single green exe: no VC++ redistributable and no embedded payload.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

add_executable(CepZhInstaller WIN32
    src/main.cpp
    src/installer.cpp
    src/util.cpp
    res/app.rc
    res/app.ico
    third_party/miniz/miniz.c
    third_party/miniz/miniz_tdef.c
    third_party/miniz/miniz_tinfl.c
    third_party/miniz/miniz_zip.c
)

target_compile_features(CepZhInstaller PRIVATE cxx_std_17)

# RC does not track the manifest/icon referenced from app.rc on every generator.
set_source_files_properties(res/app.rc PROPERTIES
    OBJECT_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/res/app.manifest;${CMAKE_CURRENT_SOURCE_DIR}/res/app.ico"
)

target_include_directories(CepZhInstaller PRIVATE
    src
    res
    third_party/miniz
)

target_compile_options(CepZhInstaller PRIVATE
    /utf-8
    /W4
    /permissive-
    /EHsc
    /O2
    /Gy
    /Gw
)

target_compile_definitions(CepZhInstaller PRIVATE
    UNICODE
    _UNICODE
    WINVER=0x0601
    _WIN32_WINNT=0x0601
    NTDDI_VERSION=0x06010000
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS
)

target_link_libraries(CepZhInstaller PRIVATE
    d2d1
    dwrite
    winhttp
    version
    shell32
    ole32
    shlwapi
    user32
    gdi32
    advapi32
)

target_link_options(CepZhInstaller PRIVATE
    /MANIFEST:NO
    /SUBSYSTEM:WINDOWS,6.01
    /DYNAMICBASE
    /NXCOMPAT
    /OPT:REF
    /OPT:ICF
)

set_target_properties(CepZhInstaller PROPERTIES OUTPUT_NAME "CepZhInstaller")
