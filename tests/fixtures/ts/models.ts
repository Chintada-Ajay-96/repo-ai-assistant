export interface User {
  id: string;
  name: string;
}

export type UserId = string | number;

export class UserManager {
  private users: User[] = [];

  constructor() {
    this.users = [];
  }

  findUser(id: UserId): User | undefined {
    return this.users.find(u => u.id === id);
  }

  clear = (): void => {
    this.users = [];
  };
}
