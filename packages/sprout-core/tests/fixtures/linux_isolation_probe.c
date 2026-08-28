#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <unistd.h>

static int write_file(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return -1;
  int result = write(fd, "ok", 2);
  close(fd);
  return result;
}

int main(void) {
  assert(write_file("allowed") == 2);
  assert(write_file(".git/denied") == -1);
  assert(write_file("/outside") == -1);
  assert(getenv("HOME") == NULL);
  assert(getenv("AWS_ACCESS_KEY_ID") == NULL);
  assert(strcmp(getenv("LANG"), "C") == 0);

  errno = 0;
  assert(mount(NULL, "/workspace/.git", NULL, MS_REMOUNT, NULL) == -1);
  assert(errno == EPERM);

  /* A private network namespace is necessary but insufficient on its own. The socket may be
     creatable, but it must have no route to caller or host services. */
  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd >= 0) close(socket_fd);
  return 0;
}
