#include <stdio.h>
#include <stddef.h>
typedef struct { size_t length; void* str; void (*dtor)(void*); } cef_string_t;
typedef int cef_log_severity_t;
typedef unsigned int cef_color_t;
typedef struct _cef_settings_t {
  size_t size;
  int no_sandbox;
  cef_string_t browser_subprocess_path;
  cef_string_t framework_dir_path;
  cef_string_t main_bundle_path;
  int chrome_runtime;
  int multi_threaded_message_loop;
  int external_message_pump;
  int windowless_rendering_enabled;
  int command_line_args_disabled;
  cef_string_t cache_path;
  cef_string_t root_cache_path;
  cef_string_t user_data_path;
  int persist_session_cookies;
  int persist_user_preferences;
  cef_string_t user_agent;
  cef_string_t user_agent_product;
  cef_string_t locale;
  cef_string_t log_file;
  cef_log_severity_t log_severity;
  cef_string_t javascript_flags;
  cef_string_t resources_dir_path;
  cef_string_t locales_dir_path;
  int pack_loading_disabled;
  int remote_debugging_port;
  int uncaught_exception_stack_size;
  cef_color_t background_color;
  cef_string_t accept_language_list;
  cef_string_t cookieable_schemes_list;
  int cookieable_schemes_exclude_defaults;
  cef_string_t application_client_id_for_file_scanning;
} cef_settings_t;
int main(){ printf("sizeof=%zu offset_port=%zu offset_size=%zu\n", sizeof(cef_settings_t), offsetof(cef_settings_t, remote_debugging_port), offsetof(cef_settings_t, size)); return 0; }
