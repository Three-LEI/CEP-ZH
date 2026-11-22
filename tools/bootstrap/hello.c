#include <windows.h>
BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r){ if(reason==DLL_PROCESS_ATTACH){ HANDLE f=CreateFileA("C:\\Users\\LEI\\AppData\\Local\\Temp\\cepzh-hello.log",GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0); if(f!=INVALID_HANDLE_VALUE){ DWORD w; WriteFile(f,"hello",5,&w,0); CloseHandle(f);} } return TRUE; }

