use super::{Actor, Role};
use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Sell,
    RecordDebt,
    AdjustDebt,
    AdjustStock,
    VoidOwnSaleSameDay,
    VoidAnySale,
    EnrollProduct,
    ChangePrice,
    ArchiveProduct,
    AddExpense,
    EditAnyExpense,
    ReviewQueue,
    ViewAlerts,
    RecognitionReport,
    DayClose,
    Exports,
    ManageStore,
    ManageMembers,
    ManageInvites,
}
/// Resource ownership and same-day checks remain the handler's responsibility.
pub fn can(actor: &Actor, action: Action) -> bool {
    actor.role == Role::Lead
        || matches!(
            action,
            Action::Sell | Action::RecordDebt | Action::VoidOwnSaleSameDay | Action::AddExpense
        )
        || (action == Action::EnrollProduct && actor.can_enroll)
}
impl Actor {
    pub fn require(&self, action: Action) -> ApiResult<()> {
        if can(self, action) {
            Ok(())
        } else {
            Err(match action {
                Action::ChangePrice => ApiError::forbidden_with(
                    "only the store owner can change prices, costs and product units",
                ),
                Action::DayClose => ApiError::forbidden_with(
                    "only the store owner can view or close the day's cash",
                ),
                _ => ApiError::forbidden(),
            })
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn require_denies_seller_management() {
        let actor = Actor {
            member_id: uuid::Uuid::nil(),
            store_id: uuid::Uuid::nil(),
            clerk_user_id: "user_test".into(),
            clerk_session_id: "sess_test".into(),
            role: Role::Seller,
            can_enroll: false,
        };
        assert!(actor.require(Action::Sell).is_ok());
        assert_eq!(
            actor.require(Action::ManageMembers).unwrap_err().code,
            "forbidden"
        );
    }
}
