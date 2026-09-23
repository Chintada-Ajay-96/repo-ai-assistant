function generateToken(user) {
  return jwt.sign({ id: user.id }, SECRET);
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

class AuthService {
  login(user) {
    return generateToken(user);
  }
}