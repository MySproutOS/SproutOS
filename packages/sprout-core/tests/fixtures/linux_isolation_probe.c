#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/syscall.h>
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
  assert(getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") == NULL);
  assert(getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI") == NULL);
  assert(getenv("SPROUT_ECS_PROOF_SECRET") == NULL);
  assert(strcmp(getenv("LANG"), "C") == 0);
  assert(open("/proc/self/environ", O_RDONLY) == -1);
  assert(open("/etc/passwd", O_RDONLY) == -1);
  assert(open("/run/secrets/credential", O_RDONLY) == -1);

  for (int fd = 3; fd < 1024; fd++) {
    errno = 0;
    assert(fcntl(fd, F_GETFD) == -1);
    assert(errno == EBADF);
  }

  errno = 0;
  assert(mount(NULL, "/workspace/.git", NULL, MS_REMOUNT, NULL) == -1);
  assert(errno == EPERM);

  /* Bubblewrap consumes the sealed filter FD during setup. The filter is then installed in both
     its PID-namespace init and this plugin, so no descendant can open or join another namespace. */
  errno = 0;
  assert(syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, (void *)1, NULL, NULL, 0) == -1);
  assert(errno == EPERM);
  errno = 0;
  assert(syscall(SYS_clone3, NULL, 0) == -1);
  /* Docker's default filter deliberately reports clone3 as ENOSYS; the inner filter also denies
     it, and stacked seccomp filters may retain the outer errno payload. */
  assert(errno == EPERM || errno == ENOSYS);
  errno = 0;
  assert(unshare(CLONE_NEWUSER) == -1);
  assert(errno == EPERM);
  errno = 0;
  assert(setns(-1, CLONE_NEWUSER) == -1);
  assert(errno == EPERM);

  /* No network descriptor is inherited, and sealed seccomp denies both socket creation
     primitives even when the hosted kernel cannot configure a private network namespace. */
  errno = 0;
  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  assert(socket_fd == -1);
  assert(errno == EPERM);

  static const char response[] =
      "{\"status\":\"ok\",\"protocol_version\":1,\"changes\":[{\"path\":\"allowed\","
      "\"kind\":\"created\",\"before_sha256\":null,\"after_sha256\":"
      "\"2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df\"}],"
      "\"warnings\":[]}";
  assert(write(STDOUT_FILENO, response, sizeof(response) - 1) == sizeof(response) - 1);
  return 0;
}
